/**
 * S1-S9 — Shopify install grant safety, against a real PostgreSQL.
 *
 * A Shopify install context is a bearer credential: one row holding a shop's
 * access token, waiting for a finalize to turn it into a connected integration.
 * Everything that can go wrong with it is a concurrency or authority question,
 * and every previous proof was a mock of a DELETE — which can only ever
 * demonstrate that the mock behaves as written.
 *
 * This seam runs the real module against a real server, with separate `pg`
 * clients for the cases that are about two PROCESSES:
 *
 *   - N finalizers racing one token yield exactly one winner, one integration
 *     and one registration of each provider side effect;
 *   - a claim from a foreign session, a claim naming a foreign target business,
 *     and a claim of an expired context are each refused with the grant left
 *     intact for whoever it actually belongs to;
 *   - a transient failure during the credential write leaves an explicitly
 *     RETRYABLE state — the grant restored, no expiry extension, zero provider
 *     mutations — and the retry registers each side effect exactly once;
 *   - a terminal failure does NOT resurrect the grant, because a retry cannot
 *     succeed and a live shop credential must not sit in a claimable table;
 *   - a reconnect that lands mid-install refuses the remaining provider
 *     mutations instead of sending a superseded token to Shopify;
 *   - and a second install of the same shop does not create a second
 *     customer-events pixel, which would double-count every order.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

import type { ShopifyInstallSideEffects } from "@/lib/shopify/install-context";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB = "shopify_install_seam";
const USER = "postgres";
const LABEL = "[shopify-install-seam]";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`shopify install seam FAILED: ${message}`);
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
 * Provider registrations recorded rather than performed.
 *
 * Counting them is the whole point: "exactly one winner" is uninteresting if
 * seven losers still registered webhooks, and "retryable" is a lie if the failed
 * attempt already created a pixel the retry creates again.
 */
function recordingSideEffects() {
  const calls = { webhooks: [] as string[], pixel: [] as string[] };
  const sideEffects: ShopifyInstallSideEffects = {
    async registerWebhooks(input) {
      calls.webhooks.push(input.shopId);
      return { created: [] };
    },
    async registerPixel(input) {
      calls.pixel.push(input.shopId);
      return { pixelId: `px_${calls.pixel.length}` };
    },
  };
  return { calls, sideEffects };
}

/** The claim statement as the module issues it, for the cross-client race. */
const RAW_CLAIM_SQL = `
  DELETE FROM shopify_install_contexts
  WHERE token = $1
    AND expires_at > now()
    AND (session_id IS NULL OR session_id = $2::uuid)
    AND (user_id IS NULL OR user_id = $3::uuid)
    AND (preferred_business_id IS NULL OR preferred_business_id = $4::uuid)
  RETURNING id::text AS id
`;

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-shopify-install-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let started = false;
  let client: Client | null = null;
  let observer: Client | null = null;
  let locker: Client | null = null;
  let resetDbClientCache: (() => void) | null = null;

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
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
      process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ??
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const db = await import("@/lib/db");
    resetDbClientCache = db.resetDbClientCache;
    db.resetDbClientCache();
    const { runMigrations } = await import("@/lib/migrations");
    await runMigrations({ force: true, reason: "shopify_install_seam" });

    const {
      consumeShopifyInstallContext,
      createShopifyInstallContext,
      finalizeShopifyInstall,
      restoreShopifyInstallContext,
    } = await import("@/lib/shopify/install-context");
    const { getIntegration, upsertIntegration } = await import("@/lib/integrations");

    client = new Client({ connectionString });
    await client.connect();
    observer = new Client({ connectionString });
    await observer.connect();
    locker = new Client({ connectionString });
    await locker.connect();

    const owner = await client.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Shopify install', 'shopify-install@example.invalid', 'unused')
       RETURNING id::text AS id`,
    );
    const ownerId = owner.rows[0]!.id;
    const stranger = await client.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Stranger', 'shopify-stranger@example.invalid', 'unused')
       RETURNING id::text AS id`,
    );
    const strangerId = stranger.rows[0]!.id;

    const makeBusiness = async (name: string) =>
      (
        await client!.query<{ id: string }>(
          `INSERT INTO businesses (name, owner_id) VALUES ($1, $2::uuid)
           RETURNING id::text AS id`,
          [name, ownerId],
        )
      ).rows[0]!.id;
    const makeSession = async (userId: string, label: string) =>
      (
        await client!.query<{ id: string }>(
          `INSERT INTO sessions (user_id, token_hash, expires_at)
           VALUES ($1::uuid, $2, now() + interval '1 day')
           RETURNING id::text AS id`,
          [userId, `hash-${label}`],
        )
      ).rows[0]!.id;

    const businessA = await makeBusiness("Install target A");
    const businessB = await makeBusiness("Install target B");
    const sessionId = await makeSession(ownerId, "owner");
    const strangerSessionId = await makeSession(strangerId, "stranger");

    const contextCount = async (token: string) =>
      Number(
        (
          await observer!.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM shopify_install_contexts WHERE token = $1`,
            [token],
          )
        ).rows[0]!.count,
      );
    const connectionCount = async (businessId: string) =>
      Number(
        (
          await observer!.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM provider_connections
             WHERE business_id = $1 AND provider = 'shopify' AND status = 'connected'`,
            [businessId],
          )
        ).rows[0]!.count,
      );

    // ── S1. N concurrent finalizers, one grant ──────────────────────────────
    const raceContext = await createShopifyInstallContext({
      shopDomain: "race.myshopify.com",
      shopName: "Race",
      accessToken: "shpat_race",
      scopes: "read_orders",
      sessionId,
      userId: ownerId,
      preferredBusinessId: businessA,
    });
    const raceRecorder = recordingSideEffects();
    const raceResults = await Promise.all(
      Array.from({ length: 8 }, () =>
        finalizeShopifyInstall({
          token: raceContext.token,
          businessId: businessA,
          sessionId,
          userId: ownerId,
          sideEffects: raceRecorder.sideEffects,
        }),
      ),
    );
    const raceWinners = raceResults.filter((result) => result.ok);
    assert(
      raceWinners.length === 1,
      `S1: ${raceWinners.length} of 8 concurrent finalizers won the same grant; a claim must be single-use.`,
    );
    assert(
      raceResults
        .filter((result) => !result.ok)
        .every(
          (result) => !result.ok && result.failure.code === "context_not_found",
        ),
      `S1: a loser reported something other than a spent context: ${JSON.stringify(
        raceResults.filter((result) => !result.ok),
      )}`,
    );
    assert(
      raceRecorder.calls.webhooks.length === 1 && raceRecorder.calls.pixel.length === 1,
      `S1: provider side effects ran ${raceRecorder.calls.webhooks.length} webhook and ${raceRecorder.calls.pixel.length} pixel times for one grant.`,
    );
    assert(
      (await contextCount(raceContext.token)) === 0 &&
        (await connectionCount(businessA)) === 1,
      "S1: the spent grant or the resulting connection is not what a single install should leave behind.",
    );
    console.log(
      `${LABEL} S1 PASS single winner: 8 concurrent finalizers on one token produced exactly 1 success, 7 spent-context refusals, 1 connection, 1 webhook registration and 1 pixel creation`,
    );

    // ── S2. The same exclusivity across SEPARATE clients ────────────────────
    //
    // S1 ran in one process against one pool. The failure this covers is two
    // PROCESSES — a web container and a retrying browser tab — so the claim is
    // raced from two independent backends and then against the module itself.
    const twoClientContext = await createShopifyInstallContext({
      shopDomain: "twoclient.myshopify.com",
      accessToken: "shpat_twoclient",
      sessionId,
      userId: ownerId,
      preferredBusinessId: businessB,
    });
    const rawArgs = [twoClientContext.token, sessionId, ownerId, businessB];
    const [rawFirst, rawSecond] = await Promise.all([
      client.query<{ id: string }>(RAW_CLAIM_SQL, rawArgs),
      observer.query<{ id: string }>(RAW_CLAIM_SQL, rawArgs),
    ]);
    assert(
      rawFirst.rows.length + rawSecond.rows.length === 1,
      `S2: two separate clients claimed the same token ${rawFirst.rows.length + rawSecond.rows.length} times.`,
    );

    const moduleVsClientContext = await createShopifyInstallContext({
      shopDomain: "crossclient.myshopify.com",
      accessToken: "shpat_crossclient",
      sessionId,
      userId: ownerId,
      preferredBusinessId: businessB,
    });
    const crossRecorder = recordingSideEffects();
    const [moduleResult, foreignClaim] = await Promise.all([
      finalizeShopifyInstall({
        token: moduleVsClientContext.token,
        businessId: businessB,
        sessionId,
        userId: ownerId,
        sideEffects: crossRecorder.sideEffects,
      }),
      client.query<{ id: string }>(RAW_CLAIM_SQL, [
        moduleVsClientContext.token,
        sessionId,
        ownerId,
        businessB,
      ]),
    ]);
    const crossWinners = (moduleResult.ok ? 1 : 0) + foreignClaim.rows.length;
    assert(
      crossWinners === 1,
      `S2: the module and a separate client both claimed the same grant (${crossWinners} winners).`,
    );
    if (!moduleResult.ok) {
      assert(
        moduleResult.failure.code === "context_not_found" &&
          crossRecorder.calls.webhooks.length === 0 &&
          crossRecorder.calls.pixel.length === 0 &&
          (await connectionCount(businessB)) === 0,
        `S2: the module lost the race but still acted: ${JSON.stringify(moduleResult.failure)} with ${crossRecorder.calls.pixel.length} pixel calls.`,
      );
    } else {
      assert(
        foreignClaim.rows.length === 0,
        "S2: the module won the race and a separate client claimed the row as well.",
      );
    }
    console.log(
      `${LABEL} S2 PASS cross-process exclusivity: two independent backends racing one claim produced exactly 1 winner, and the module racing a foreign client produced exactly 1 winner with the loser performing no provider work`,
    );

    // ── S3. A foreign session is refused, and the grant survives ────────────
    const foreignSessionContext = await createShopifyInstallContext({
      shopDomain: "foreign.myshopify.com",
      accessToken: "shpat_foreign",
      sessionId,
      userId: ownerId,
      preferredBusinessId: businessA,
    });
    const strangerRecorder = recordingSideEffects();
    const strangerResult = await finalizeShopifyInstall({
      token: foreignSessionContext.token,
      businessId: businessA,
      sessionId: strangerSessionId,
      userId: strangerId,
      sideEffects: strangerRecorder.sideEffects,
    });
    assert(
      !strangerResult.ok && strangerResult.failure.code === "context_not_yours",
      `S3: a finalize from a different session was accepted: ${JSON.stringify(strangerResult)}`,
    );
    const survivingToken = await observer.query<{ access_token: string }>(
      `SELECT access_token FROM shopify_install_contexts WHERE token = $1`,
      [foreignSessionContext.token],
    );
    assert(
      survivingToken.rows[0]?.access_token === "shpat_foreign" &&
        strangerRecorder.calls.pixel.length === 0,
      "S3: a refused claim destroyed or acted on a grant that belongs to someone else.",
    );
    const rightfulOwner = await finalizeShopifyInstall({
      token: foreignSessionContext.token,
      businessId: businessA,
      sessionId,
      userId: ownerId,
      sideEffects: recordingSideEffects().sideEffects,
    });
    assert(
      rightfulOwner.ok,
      `S3: the rightful owner could not finalize afterwards: ${JSON.stringify(rightfulOwner)}`,
    );
    console.log(
      `${LABEL} S3 PASS foreign session: a stranger's finalize is refused as not-yours with 0 provider calls, the grant is left byte-intact, and the session that started the install still completes it`,
    );

    // ── S4. A foreign TARGET BUSINESS is refused ────────────────────────────
    //
    // Same session, same user, same everything the previous binding checked —
    // and a different business. The user legitimately belongs to both, so only
    // the recorded target tells the two apart.
    const wrongBusinessContext = await createShopifyInstallContext({
      shopDomain: "target.myshopify.com",
      accessToken: "shpat_target",
      sessionId,
      userId: ownerId,
      preferredBusinessId: businessA,
    });
    const wrongBusinessRecorder = recordingSideEffects();
    const wrongBusinessResult = await finalizeShopifyInstall({
      token: wrongBusinessContext.token,
      businessId: businessB,
      sessionId,
      userId: ownerId,
      sideEffects: wrongBusinessRecorder.sideEffects,
    });
    assert(
      !wrongBusinessResult.ok &&
        wrongBusinessResult.failure.code === "context_wrong_business",
      `S4: an install started for one business was finalized into another: ${JSON.stringify(wrongBusinessResult)}`,
    );
    const businessBShop = await observer.query<{ provider_account_id: string | null }>(
      `SELECT provider_account_id FROM provider_connections
       WHERE business_id = $1 AND provider = 'shopify'`,
      [businessB],
    );
    assert(
      businessBShop.rows[0]?.provider_account_id !== "target.myshopify.com" &&
        wrongBusinessRecorder.calls.pixel.length === 0 &&
        (await contextCount(wrongBusinessContext.token)) === 1,
      `S4: the refused finalize still touched the wrong business: ${JSON.stringify(businessBShop.rows[0])}`,
    );
    const correctBusiness = await finalizeShopifyInstall({
      token: wrongBusinessContext.token,
      businessId: businessA,
      sessionId,
      userId: ownerId,
      sideEffects: recordingSideEffects().sideEffects,
    });
    assert(
      correctBusiness.ok,
      `S4: the business the install was started for could not finalize it: ${JSON.stringify(correctBusiness)}`,
    );
    console.log(
      `${LABEL} S4 PASS target business: a finalize naming a different business — same session, same user, both memberships real — is refused, the wrong business gains no shop and no provider call, and the intended business completes the install`,
    );

    // ── S5. An expired context is refused ──────────────────────────────────
    const expiredContext = await createShopifyInstallContext({
      shopDomain: "expired.myshopify.com",
      accessToken: "shpat_expired",
      sessionId,
      userId: ownerId,
      preferredBusinessId: businessB,
    });
    await client.query(
      `UPDATE shopify_install_contexts SET expires_at = now() - interval '1 minute'
       WHERE token = $1`,
      [expiredContext.token],
    );
    const expiredRecorder = recordingSideEffects();
    const expiredResult = await finalizeShopifyInstall({
      token: expiredContext.token,
      businessId: businessB,
      sessionId,
      userId: ownerId,
      sideEffects: expiredRecorder.sideEffects,
    });
    assert(
      !expiredResult.ok && expiredResult.failure.code === "context_not_found",
      `S5: an expired grant was accepted: ${JSON.stringify(expiredResult)}`,
    );
    assert(
      expiredRecorder.calls.webhooks.length === 0 &&
        expiredRecorder.calls.pixel.length === 0,
      "S5: an expired grant reached the provider.",
    );
    console.log(
      `${LABEL} S5 PASS expiry: a context past its expiry is refused as not-found with 0 provider calls, and cannot be claimed by anyone`,
    );

    // ── S6. A transient failure is explicitly RETRYABLE ────────────────────
    //
    // The credential write is made to fail the way contention makes it fail:
    // another session holds the connection row this write must take `FOR UPDATE`,
    // and a database-level `lock_timeout` cancels the wait. PostgreSQL rolls the
    // statement back itself, so the failure is genuinely a write that did not
    // land — and because it is a ROW lock, the recovery probe's plain read is
    // not blocked and can still answer whether the grant persisted.
    const businessC = await makeBusiness("Install target C");
    await upsertIntegration({
      businessId: businessC,
      provider: "shopify",
      status: "connected",
      providerAccountId: "retry.myshopify.com",
      providerAccountName: "Retry",
      accessToken: "shpat_retry_previous",
    });
    const retryContext = await createShopifyInstallContext({
      shopDomain: "retry.myshopify.com",
      accessToken: "shpat_retry_new",
      sessionId,
      userId: ownerId,
      preferredBusinessId: businessC,
    });
    const retryRecorder = recordingSideEffects();

    // Applied at the database level because the application sets only
    // `statement_timeout`, and a lock timeout is what turns "waiting forever" —
    // which no test can wait out — into a deterministic, rolled-back failure.
    await client.query(`ALTER DATABASE ${DB} SET lock_timeout = '400ms'`);
    db.resetDbClientCache();

    await locker.query("BEGIN");
    await locker.query(
      `SELECT id FROM provider_connections
       WHERE business_id = $1 AND provider = 'shopify' FOR UPDATE`,
      [businessC],
    );
    const retryFailure = await finalizeShopifyInstall({
      token: retryContext.token,
      businessId: businessC,
      sessionId,
      userId: ownerId,
      sideEffects: retryRecorder.sideEffects,
    });
    await locker.query("COMMIT");
    await client.query(`ALTER DATABASE ${DB} RESET lock_timeout`);
    db.resetDbClientCache();

    assert(
      !retryFailure.ok &&
        retryFailure.failure.code === "integration_save_failed" &&
        retryFailure.failure.retryable === true &&
        retryFailure.failure.grant === "restored",
      `S6: a transient credential-write failure did not report a retryable, restored grant: ${JSON.stringify(retryFailure)}`,
    );
    assert(
      retryRecorder.calls.webhooks.length === 0 &&
        retryRecorder.calls.pixel.length === 0,
      `S6: a failed install still performed ${retryRecorder.calls.webhooks.length} webhook and ${retryRecorder.calls.pixel.length} pixel registrations.`,
    );
    const restored = await observer.query<{
      access_token: string;
      expires_at: string;
      within_original: boolean;
    }>(
      `SELECT access_token, expires_at::text AS expires_at,
              expires_at <= $2::timestamptz AS within_original
       FROM shopify_install_contexts WHERE token = $1`,
      [retryContext.token, retryContext.expires_at],
    );
    assert(
      restored.rows[0]?.access_token === "shpat_retry_new",
      "S6: the restored grant is not the one that was claimed.",
    );
    assert(
      restored.rows[0]?.within_original === true,
      `S6: the restore EXTENDED the grant past the expiry the user consented to (${restored.rows[0]?.expires_at} > ${retryContext.expires_at}).`,
    );
    const preservedShop = await observer.query<{ provider_account_id: string | null }>(
      `SELECT provider_account_id FROM provider_connections
       WHERE business_id = $1 AND provider = 'shopify'`,
      [businessC],
    );
    assert(
      preservedShop.rows[0]?.provider_account_id === "retry.myshopify.com",
      "S6: the rolled-back write left the previous connection changed.",
    );

    const retrySucceeded = await finalizeShopifyInstall({
      token: retryContext.token,
      businessId: businessC,
      sessionId,
      userId: ownerId,
      sideEffects: retryRecorder.sideEffects,
    });
    assert(
      retrySucceeded.ok,
      `S6: the retry of a restored grant failed: ${JSON.stringify(retrySucceeded)}`,
    );
    const webhookCallsAcrossBothAttempts: number = retryRecorder.calls.webhooks.length;
    const pixelCallsAcrossBothAttempts: number = retryRecorder.calls.pixel.length;
    assert(
      webhookCallsAcrossBothAttempts === 1 && pixelCallsAcrossBothAttempts === 1,
      `S6: across the failed attempt and its retry the side effects ran ${webhookCallsAcrossBothAttempts} webhook and ${pixelCallsAcrossBothAttempts} pixel times; exactly one of each is the contract.`,
    );
    const retriedIntegration = await getIntegration(businessC, "shopify");
    assert(
      retriedIntegration?.access_token === "shpat_retry_new",
      `S6: the retry did not store the new credential: ${JSON.stringify(retriedIntegration?.provider_account_id)}`,
    );
    console.log(
      `${LABEL} S6 PASS retryable failure: a credential write cancelled by contention (${retryFailure.ok ? "" : retryFailure.failure.detail}) leaves an explicitly retryable state — the grant restored with its ORIGINAL expiry intact, the previous connection untouched, 0 provider mutations — and the retry completes with exactly 1 webhook registration and 1 pixel creation across both attempts`,
    );

    // ── S7. A terminal failure does NOT resurrect the grant ────────────────
    const businessD = await makeBusiness("Install target D");
    const terminalContext = await createShopifyInstallContext({
      shopDomain: "terminal.myshopify.com",
      accessToken: "shpat_terminal",
      sessionId,
      userId: ownerId,
      preferredBusinessId: businessD,
    });
    const terminalRecorder = recordingSideEffects();
    const encryptionKey = process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY;
    delete process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY;
    const terminalResult = await finalizeShopifyInstall({
      token: terminalContext.token,
      businessId: businessD,
      sessionId,
      userId: ownerId,
      sideEffects: terminalRecorder.sideEffects,
    });
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = encryptionKey;
    assert(
      !terminalResult.ok &&
        terminalResult.failure.code === "integration_save_failed_terminal" &&
        terminalResult.failure.retryable === false &&
        terminalResult.failure.grant === "discarded",
      `S7: a failure no retry can fix was reported as retryable: ${JSON.stringify(terminalResult)}`,
    );
    assert(
      (await contextCount(terminalContext.token)) === 0,
      "S7: a terminal failure put a live shop credential back into a claimable table.",
    );
    const terminalReclaim = await consumeShopifyInstallContext({
      token: terminalContext.token,
      sessionId,
      userId: ownerId,
      targetBusinessId: businessD,
    });
    assert(
      !terminalReclaim.ok && terminalReclaim.reason === "not_found",
      `S7: the discarded grant was still claimable: ${JSON.stringify(terminalReclaim)}`,
    );
    assert(
      (await connectionCount(businessD)) === 0 &&
        terminalRecorder.calls.pixel.length === 0,
      "S7: a terminal failure left a connection or reached the provider.",
    );
    console.log(
      `${LABEL} S7 PASS terminal failure: a misconfiguration that fails identically on every retry reports retryable=false, leaves 0 claimable grants, 0 connections and 0 provider calls, and the token cannot be claimed again`,
    );

    // ── S8. The restore itself cannot extend or resurrect ──────────────────
    const clampContext = await createShopifyInstallContext({
      shopDomain: "clamp.myshopify.com",
      accessToken: "shpat_clamp",
      sessionId,
      userId: ownerId,
      preferredBusinessId: businessB,
    });
    await client.query(
      `UPDATE shopify_install_contexts SET expires_at = now() + interval '20 seconds'
       WHERE token = $1`,
      [clampContext.token],
    );
    const shortLived = await consumeShopifyInstallContext({
      token: clampContext.token,
      sessionId,
      userId: ownerId,
      targetBusinessId: businessB,
    });
    assert(shortLived.ok, "S8: the short-lived grant could not be claimed.");
    assert(
      (await restoreShopifyInstallContext(shortLived.context)) === "restored",
      "S8: a live grant could not be restored.",
    );
    const clamped = await observer.query<{ within_original: boolean }>(
      `SELECT expires_at <= $2::timestamptz AS within_original
       FROM shopify_install_contexts WHERE token = $1`,
      [clampContext.token, shortLived.context.expires_at],
    );
    assert(
      clamped.rows[0]?.within_original === true,
      "S8: restoring a grant 20 seconds from expiry gave it a fresh 5-minute window.",
    );
    const expiredRestore = await restoreShopifyInstallContext({
      ...shortLived.context,
      token: `${shortLived.context.token}-expired`,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    assert(
      expiredRestore === "expired" &&
        (await contextCount(`${shortLived.context.token}-expired`)) === 0,
      `S8: an already-expired grant was resurrected: ${expiredRestore}`,
    );
    const duplicateRestore = await restoreShopifyInstallContext(shortLived.context);
    assert(
      duplicateRestore === "already_present",
      `S8: a restore over a token another process holds reported ${duplicateRestore} instead of naming the collision.`,
    );
    console.log(
      `${LABEL} S8 PASS restore bounds: a restore clamps to the ORIGINAL expiry, refuses an already-expired grant outright, and reports a token that is already present instead of claiming success`,
    );

    // ── S9. Provider generation binding, and the second pixel ──────────────
    //
    // The finalize holds a plaintext token for the whole of its registration
    // work. A reconnect that lands in that window must stop the remaining
    // provider calls, or they go out under a credential the business replaced.
    const businessE = await makeBusiness("Install target E");
    const generationContext = await createShopifyInstallContext({
      shopDomain: "generation.myshopify.com",
      accessToken: "shpat_generation",
      sessionId,
      userId: ownerId,
      preferredBusinessId: businessE,
    });
    const reconnectCalls = { webhooks: 0, pixel: 0 };
    const reconnectingSideEffects: ShopifyInstallSideEffects = {
      async registerWebhooks() {
        reconnectCalls.webhooks += 1;
        // The business is reconnected to a DIFFERENT shop while this call is in
        // flight; the token still in hand belongs to the previous grant.
        await upsertIntegration({
          businessId: businessE,
          provider: "shopify",
          status: "connected",
          providerAccountId: "reconnected.myshopify.com",
          providerAccountName: "Reconnected",
          accessToken: "shpat_reconnected",
        });
        return { created: [] };
      },
      async registerPixel() {
        reconnectCalls.pixel += 1;
        return { pixelId: "px_should_not_exist" };
      },
    };
    const generationResult = await finalizeShopifyInstall({
      token: generationContext.token,
      businessId: businessE,
      sessionId,
      userId: ownerId,
      sideEffects: reconnectingSideEffects,
    });
    assert(
      generationResult.ok &&
        generationResult.webhooks.status === "registered" &&
        generationResult.pixel.status === "refused" &&
        generationResult.pixel.code === "shopify_connection_changed",
      `S9: a provider mutation ran after the connection moved: ${JSON.stringify(generationResult)}`,
    );
    assert(
      reconnectCalls.pixel === 0,
      "S9: the pixel was created under a credential the business had already replaced.",
    );

    // The second install of the SAME shop must not create a second pixel:
    // `webPixelCreate` is a create, and two pixels means every order counted
    // twice.
    const businessF = await makeBusiness("Install target F");
    const pixelRecorder = recordingSideEffects();
    for (const attempt of [1, 2]) {
      const installContext = await createShopifyInstallContext({
        shopDomain: "pixel.myshopify.com",
        accessToken: `shpat_pixel_${attempt}`,
        sessionId,
        userId: ownerId,
        preferredBusinessId: businessF,
      });
      const outcome = await finalizeShopifyInstall({
        token: installContext.token,
        businessId: businessF,
        sessionId,
        userId: ownerId,
        sideEffects: pixelRecorder.sideEffects,
      });
      assert(outcome.ok, `S9: install attempt ${attempt} failed: ${JSON.stringify(outcome)}`);
      assert(
        attempt === 1
          ? outcome.pixel.status === "registered"
          : outcome.pixel.status === "already_registered",
        `S9: install attempt ${attempt} reported pixel status ${outcome.pixel.status}.`,
      );
    }
    assert(
      pixelRecorder.calls.pixel.length === 1 && pixelRecorder.calls.webhooks.length === 2,
      `S9: two installs of the same shop created ${pixelRecorder.calls.pixel.length} pixels; exactly one is the contract, while the idempotent webhook registration is expected to run each time (${pixelRecorder.calls.webhooks.length}).`,
    );
    const marker = await observer.query<{ shop_domain: string | null }>(
      `SELECT credential.metadata #>> '{shopifyCustomerEventsPixel,shopDomain}' AS shop_domain
       FROM provider_connections connection
       JOIN integration_credentials credential
         ON credential.provider_connection_id = connection.id
       WHERE connection.business_id = $1 AND connection.provider = 'shopify'`,
      [businessF],
    );
    assert(
      marker.rows[0]?.shop_domain === "pixel.myshopify.com",
      `S9: the completed pixel registration was not recorded durably: ${JSON.stringify(marker.rows[0])}`,
    );
    console.log(
      `${LABEL} S9 PASS generation binding: a reconnect landing mid-install refuses the remaining provider mutation with 0 calls under the superseded credential, and a second install of the same shop reuses the recorded registration so exactly 1 customer-events pixel is ever created`,
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
    await locker?.query("ROLLBACK").catch(() => undefined);
    await client?.end().catch(() => undefined);
    await observer?.end().catch(() => undefined);
    await locker?.end().catch(() => undefined);
    resetDbClientCache?.();
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
