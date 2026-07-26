/**
 * C1-C6 — who may READ a pending Shopify install context, against a real
 * PostgreSQL.
 *
 * `GET /api/oauth/shopify/context?token=...` required nothing at all: a token
 * that travels in a URL returned another tenant's shop domain, shop name,
 * currency and the business the install was started for, repeatedly, for the
 * whole life of the token. The fix is an authenticated read that is bound to the
 * context's actor when it recorded one, and otherwise BINDS ITSELF to the first
 * authenticated viewer who can prove they are the browser Shopify redirected.
 *
 * The unit suite can prove the decision logic and nothing else. Two claims in
 * that design are claims about a database and cannot be established with a
 * mocked `getDb`:
 *
 *   C1  the first-view binding is exclusive under genuine CONCURRENCY — eight
 *       separate connections, deliberately parked on the same row lock and
 *       released together, produce exactly one winner;
 *   C2  the same, through the real exported entrypoint;
 *   C3  a refused read mutates NOTHING — proven by hashing every row before and
 *       after a battery of refusals, not by a fake that could not have written
 *       anything anyway;
 *   C4  an expired context is unclaimable by anyone, and a refused claim does
 *       not revive it;
 *   C5  the response carries the four fields the page renders and the shop's
 *       access token is never read, let alone returned;
 *   C6  and the finalize the merchant is about to perform still succeeds — a
 *       read guard that quietly breaks a real install is not a fix.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB = "shopify_context_access_seam";
const USER = "postgres";
const LABEL = "[shopify-context-access-seam]";
const RACERS = 8;
const SHOP = "race.myshopify.com";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`shopify context access seam FAILED: ${message}`);
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

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-shopify-context-access-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
  const savedEnv = { ...process.env };
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let started = false;
  let client: Client | null = null;
  let blocker: Client | null = null;
  let racers: Client[] = [];

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
    process.env.SHOPIFY_CLIENT_SECRET = "seam-shopify-app-secret";
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
      process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ??
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const db = await import("@/lib/db");
    db.resetDbClientCache();
    const { runMigrations } = await import("@/lib/migrations");
    await runMigrations({ force: true, reason: "shopify_context_access_seam" });

    const {
      SHOPIFY_INSTALL_CONTEXT_CLAIM_SQL,
      buildShopifyInstallProof,
      readShopifyInstallContextForViewer,
    } = await import("@/lib/shopify/install-context-access");
    const { consumeShopifyInstallContext } = await import(
      "@/lib/shopify/install-context"
    );

    client = new Client({ connectionString });
    await client.connect();

    // ── Fixture ─────────────────────────────────────────────────────────────
    const makeUser = async (label: string) =>
      (
        await client!.query<{ id: string }>(
          `INSERT INTO users (name, email, password_hash)
           VALUES ($1, $2, 'unused') RETURNING id::text AS id`,
          [label, `${label}@context-seam.invalid`],
        )
      ).rows[0]!.id;
    const makeSession = async (userId: string, label: string) =>
      (
        await client!.query<{ id: string }>(
          `INSERT INTO sessions (user_id, token_hash, expires_at)
           VALUES ($1::uuid, $2, now() + interval '1 day') RETURNING id::text AS id`,
          [userId, `hash-${label}`],
        )
      ).rows[0]!.id;
    const makeBusiness = async (name: string, ownerId: string) =>
      (
        await client!.query<{ id: string }>(
          `INSERT INTO businesses (name, owner_id) VALUES ($1, $2::uuid)
           RETURNING id::text AS id`,
          [name, ownerId],
        )
      ).rows[0]!.id;
    const makeMembership = async (
      userId: string,
      businessId: string,
      role: string,
      status = "active",
    ) => {
      await client!.query(
        `INSERT INTO memberships (user_id, business_id, role, status)
         VALUES ($1::uuid, $2::uuid, $3, $4)
         ON CONFLICT (user_id, business_id) DO UPDATE
           SET role = EXCLUDED.role, status = EXCLUDED.status`,
        [userId, businessId, role, status],
      );
    };

    interface Actor {
      label: string;
      userId: string;
      sessionId: string;
      email: string;
    }
    const actor = async (label: string): Promise<Actor> => {
      const userId = await makeUser(label);
      return {
        label,
        userId,
        sessionId: await makeSession(userId, label),
        email: `${label}@context-seam.invalid`,
      };
    };

    const merchant = await actor("merchant");
    const stranger = await actor("stranger");
    const outsider = await actor("outsider");
    const crowd: Actor[] = [];
    for (let i = 0; i < RACERS; i += 1) crowd.push(await actor(`racer-${i}`));

    const businessA = await makeBusiness("Install target A", merchant.userId);
    const businessB = await makeBusiness("Install target B", stranger.userId);
    await makeMembership(merchant.userId, businessA, "admin");
    await makeMembership(stranger.userId, businessB, "admin");
    // Belongs to another workspace entirely, and to no part of the merchant's.
    await makeMembership(outsider.userId, businessB, "admin");
    // The stranger is a GUEST of the merchant's business: a membership exists,
    // and it is still not one that could ever finish this install.
    await makeMembership(stranger.userId, businessA, "guest");
    for (const racer of crowd) await makeMembership(racer.userId, businessA, "admin");

    const seedContext = async (input: {
      token: string;
      sessionId?: string | null;
      userId?: string | null;
      preferredBusinessId?: string | null;
      expiresIn?: string;
    }) => {
      await client!.query(
        `INSERT INTO shopify_install_contexts
           (token, shop_domain, shop_name, access_token, scopes, metadata,
            return_to, session_id, user_id, preferred_business_id, expires_at)
         VALUES ($1, $2, 'Race Shop', 'shpat_seam_live_credential', 'read_orders',
                 '{"currency":"EUR","iana_timezone":"Europe/Istanbul"}'::jsonb,
                 '/integrations', $3::uuid, $4::uuid, $5::uuid,
                 now() + $6::interval)`,
        [
          input.token,
          SHOP,
          input.sessionId ?? null,
          input.userId ?? null,
          input.preferredBusinessId ?? null,
          input.expiresIn ?? "30 minutes",
        ],
      );
    };

    /** Every row, hashed, so byte-identity is provable without touching the credential. */
    const census = async () =>
      JSON.stringify(
        (
          await client!.query<{ token: string; digest: string }>(
            `SELECT token, md5(c::text) AS digest
               FROM shopify_install_contexts c ORDER BY token`,
          )
        ).rows,
      );
    const bindingOf = async (token: string) =>
      (
        await client!.query<{ session_id: string | null; user_id: string | null }>(
          `SELECT session_id::text AS session_id, user_id::text AS user_id
             FROM shopify_install_contexts WHERE token = $1`,
          [token],
        )
      ).rows[0] ?? null;

    const view = (a: Actor, token: string, proof: string | null | "valid" = "valid") =>
      readShopifyInstallContextForViewer({
        token,
        sessionId: a.sessionId,
        userId: a.userId,
        userEmail: a.email,
        installProof: proof === "valid" ? buildShopifyInstallProof(token) : proof,
      });

    // ── C1. Eight connections, one binding ──────────────────────────────────
    //
    // Concurrency that is actually concurrent: a blocker transaction takes the
    // row lock, every racer's claim is fired and parks behind it, the seam waits
    // until PostgreSQL reports all eight backends waiting on a Lock, and only
    // then does the blocker commit. They are released into the same row at the
    // same instant. A `SELECT` followed by an `UPDATE` would let all eight read
    // the context first; `UPDATE ... WHERE session_id IS NULL ... RETURNING` is
    // what makes the bind and the read one decision.
    const raceToken = "c1".padEnd(64, "0");
    await seedContext({ token: raceToken, preferredBusinessId: businessA });

    blocker = new Client({ connectionString });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      `SELECT 1 FROM shopify_install_contexts WHERE token = $1 FOR UPDATE`,
      [raceToken],
    );

    racers = await Promise.all(
      crowd.map(async () => {
        const racerClient = new Client({ connectionString });
        await racerClient.connect();
        return racerClient;
      }),
    );
    const claims = racers.map((racerClient, index) =>
      racerClient.query(SHOPIFY_INSTALL_CONTEXT_CLAIM_SQL, [
        raceToken,
        crowd[index]!.sessionId,
        crowd[index]!.userId,
        null,
      ]),
    );

    /** Wait until `expected` backends are blocked on a lock in this database. */
    const waitForParked = async (expected: number) => {
      let parked = 0;
      for (let attempt = 0; attempt < 400 && parked < expected; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        parked = Number(
          (
            await client!.query<{ count: string }>(
              `SELECT COUNT(*)::text AS count FROM pg_stat_activity
                WHERE datname = $1 AND wait_event_type = 'Lock' AND state = 'active'`,
              [DB],
            )
          ).rows[0]!.count,
        );
      }
      return parked;
    };

    const parked = await waitForParked(RACERS);
    assert(
      parked === RACERS,
      `C1: only ${parked} of ${RACERS} claims were waiting on the row lock, so they were never released simultaneously and the race proves nothing.`,
    );
    await blocker.query("COMMIT");

    const raceResults = await Promise.all(claims);
    const winners = raceResults.filter((result) => result.rowCount === 1);
    assert(
      winners.length === 1,
      `C1: ${winners.length} of ${RACERS} simultaneous readers bound the same install context; the first-view claim is not exclusive.`,
    );
    const raceBinding = await bindingOf(raceToken);
    assert(
      raceBinding?.session_id != null &&
        crowd.some((racer) => racer.sessionId === raceBinding.session_id),
      `C1: the context was left bound to ${JSON.stringify(raceBinding)}, which is not one of the racers.`,
    );
    const loser = crowd.find((racer) => racer.sessionId !== raceBinding!.session_id)!;
    const loserRead = await view(loser, raceToken);
    assert(
      loserRead.ok === false,
      `C1: a losing racer could still read the context after another session bound it.`,
    );

    // ── C2. The same race, through the real entrypoint ──────────────────────
    //
    // Parked on the same barrier rather than merely fired together. Eight
    // `Promise.all`ed calls each make two or three round trips, and the event
    // loop will happily let the first one finish before the rest start their
    // lookup — a read-then-write claim survives that by luck. Holding the row
    // lock until all eight have reached their WRITE removes the luck: whatever
    // each of them decided to write is submitted into the same instant.
    const entryToken = "c2".padEnd(64, "0");
    await seedContext({ token: entryToken, preferredBusinessId: businessA });
    await blocker.query("BEGIN");
    await blocker.query(
      `SELECT 1 FROM shopify_install_contexts WHERE token = $1 FOR UPDATE`,
      [entryToken],
    );
    const entryCalls = crowd.map((a) => view(a, entryToken));
    const entryParked = await waitForParked(RACERS);
    assert(
      entryParked === RACERS,
      `C2: only ${entryParked} of ${RACERS} entrypoint calls reached a write and parked on the row lock; the race was never simultaneous.`,
    );
    await blocker.query("COMMIT");
    const entryResults = await Promise.all(entryCalls);
    const entryWinners = entryResults.filter(
      (result) => result.ok && result.binding === "claimed",
    );
    assert(
      entryWinners.length === 1,
      `C2: ${entryWinners.length} of ${RACERS} concurrent calls to readShopifyInstallContextForViewer claimed the same context.`,
    );
    assert(
      entryResults.filter((result) => result.ok).length === 1,
      `C2: ${entryResults.filter((r) => r.ok).length} of ${RACERS} concurrent callers were served the context; only the one that bound it may be.`,
    );

    // ── C3. A refused read mutates nothing ──────────────────────────────────
    const boundToken = "c3".padEnd(64, "0");
    await seedContext({
      token: boundToken,
      sessionId: merchant.sessionId,
      userId: merchant.userId,
      preferredBusinessId: businessA,
    });
    const unboundToken = "c3b".padEnd(64, "0");
    await seedContext({ token: unboundToken, preferredBusinessId: businessA });
    // The Shopify-initiated install in its weakest form: no actor and no target
    // business, so the install proof is the ONLY thing between a token holder
    // and the disclosure. Nothing else in this table can mask it.
    const openToken = "c3c".padEnd(64, "0");
    await seedContext({ token: openToken });
    // Unbound AND started for a business, viewed WITH a valid proof: nothing but
    // the membership gate can refuse this one, so it is the only case that can
    // prove the gate is load-bearing.
    const targetedToken = "c3d".padEnd(64, "0");
    await seedContext({ token: targetedToken, preferredBusinessId: businessA });

    const before = await census();
    const refusals: Array<[string, Awaited<ReturnType<typeof view>>]> = [
      ["stranger holds a bound token", await view(stranger, boundToken)],
      ["stranger holds an unbound token, no proof", await view(stranger, unboundToken, null)],
      [
        "stranger holds an unbound token, forged proof",
        await view(stranger, unboundToken, "0".repeat(64)),
      ],
      [
        "stranger replays the token as its own proof",
        await view(stranger, unboundToken, unboundToken),
      ],
      ["bearer of an actorless, businessless token, no proof", await view(stranger, openToken, null)],
      [
        "bearer of an actorless, businessless token, forged proof",
        await view(stranger, openToken, "0".repeat(64)),
      ],
      [
        "bearer of an actorless, businessless token, token as its own proof",
        await view(stranger, openToken, openToken),
      ],
      [
        "non-member of the target business, with a valid proof",
        await view(outsider, targetedToken),
      ],
      [
        "guest of the target business, with a valid proof",
        await view(stranger, targetedToken),
      ],
      ["unknown token", await view(merchant, "ff".padEnd(64, "f"))],
      ["wrong-length token", await view(merchant, "ff")],
      ["empty token", await view(merchant, "")],
    ];
    for (const [name, result] of refusals) {
      assert(
        result.ok === false,
        `C3: "${name}" was SERVED the install context; the read guard does not hold.`,
      );
    }
    const after = await census();
    assert(
      before === after,
      `C3: a refused read changed the install-contexts table.\nbefore=${before}\nafter=${after}`,
    );
    const openBinding = await bindingOf(openToken);
    assert(
      openBinding?.session_id == null && openBinding?.user_id == null,
      `C3: a token holder who could not prove the redirect BOUND an actorless install to themselves: ${JSON.stringify(openBinding)}.`,
    );
    // ...and the merchant, arriving with the proof the callback gave their
    // browser, still gets their own install.
    const openMerchant = await view(merchant, openToken);
    assert(
      openMerchant.ok && openMerchant.binding === "claimed",
      `C3: the browser Shopify redirected was refused its own actorless install: ${JSON.stringify(openMerchant)}`,
    );

    // The stranger IS a member of the merchant's business — as a guest — and is
    // still refused: only a role that could finalize the install may see it.
    const guestRead = await view(stranger, boundToken);
    assert(
      guestRead.ok === false,
      `C3: a guest of the target business was served an install they could never finalize.`,
    );
    // ...while the collaborator the install was started for is served it.
    const targetedMerchant = await view(merchant, targetedToken);
    assert(
      targetedMerchant.ok,
      `C3: the admin of the business this install was started for was refused it: ${JSON.stringify(targetedMerchant)}`,
    );

    // ── C4. An expired context is unclaimable by anyone ─────────────────────
    const expiredToken = "c4".padEnd(64, "0");
    await seedContext({ token: expiredToken, expiresIn: "-1 minutes" });
    const expiredBefore = await census();
    for (const a of [merchant, stranger, ...crowd]) {
      const result = await view(a, expiredToken);
      assert(
        result.ok === false,
        `C4: ${a.label} claimed an EXPIRED install context; an expired grant must not be revivable by viewing it.`,
      );
    }
    const expiredBinding = await bindingOf(expiredToken);
    assert(
      expiredBinding?.session_id == null && expiredBinding?.user_id == null,
      `C4: the expired context was bound anyway: ${JSON.stringify(expiredBinding)}.`,
    );
    assert(
      expiredBefore === (await census()),
      `C4: refusing an expired context still mutated the table.`,
    );

    // ── C5. Minimal disclosure, and the credential is never read ────────────
    const merchantRead = await view(merchant, boundToken);
    assert(merchantRead.ok, `C5: the first-party merchant was refused their own install.`);
    assert(
      merchantRead.ok &&
        JSON.stringify(Object.keys(merchantRead.context).sort()) ===
          JSON.stringify([
            "currency",
            "preferredBusinessId",
            "shopDomain",
            "shopName",
          ]),
      `C5: the response carries fields the page does not render: ${JSON.stringify(
        merchantRead.ok ? Object.keys(merchantRead.context) : null,
      )}`,
    );
    const serialized = JSON.stringify(merchantRead);
    assert(
      !serialized.includes("shpat_seam_live_credential") &&
        !serialized.includes("access_token") &&
        !serialized.includes("read_orders") &&
        !serialized.includes("iana_timezone"),
      `C5: the response disclosed the shop credential, its scopes, or metadata the page never reads: ${serialized}`,
    );
    assert(
      !SHOPIFY_INSTALL_CONTEXT_CLAIM_SQL.includes("access_token"),
      `C5: the claim statement names the shop's access token.`,
    );
    assert(
      merchantRead.ok &&
        merchantRead.context.shopDomain === SHOP &&
        merchantRead.context.currency === "EUR" &&
        merchantRead.context.preferredBusinessId === businessA,
      `C5: the merchant's own install did not come back intact: ${serialized}`,
    );

    // ── C6. The install the merchant is here to finish still finishes ───────
    //
    // The read guard binds `session_id`/`user_id` on first view, and the finalize
    // claim checks exactly those columns. A guard that bound the context to
    // something the finalize then rejects would have locked every
    // Shopify-initiated merchant out of their own install.
    const flowToken = "c6".padEnd(64, "0");
    await seedContext({ token: flowToken });
    const firstView = await view(merchant, flowToken);
    assert(
      firstView.ok && firstView.binding === "claimed",
      `C6: the Shopify-initiated first view did not bind the context: ${JSON.stringify(firstView)}`,
    );
    const refresh = await view(merchant, flowToken);
    assert(
      refresh.ok && refresh.binding === "already_bound",
      `C6: the merchant could not refresh the page they were just served.`,
    );
    const finalize = await consumeShopifyInstallContext({
      token: flowToken,
      sessionId: merchant.sessionId,
      userId: merchant.userId,
      targetBusinessId: businessA,
    });
    assert(
      finalize.ok,
      `C6: the finalize REFUSED an install the read path had just bound to the same session (${JSON.stringify(finalize)}); the guard breaks real merchants.`,
    );
    assert(
      (await bindingOf(flowToken)) === null,
      `C6: the finalize did not consume the context it claimed.`,
    );

    console.log(
      `${LABEL} C1-C6 PASS real-database install-context read authority: ${RACERS} separate connections parked on one row lock and released together yield exactly 1 binding (and ${RACERS - 1} refusals), the same race through readShopifyInstallContextForViewer yields exactly 1 winner, ${refusals.length} distinct refusals — foreign session, absent proof, forged proof, token-as-its-own-proof, non-member and guest of the target business, unknown, wrong-length and empty tokens — leave every row byte-identical, while the admin of the business the install was started for is served it, an expired context is unclaimable by all ${crowd.length + 2} actors and is not revived, the response carries exactly 4 rendered fields with no credential, scopes or metadata, and a Shopify-initiated install still binds on first view, survives a refresh, and finalizes`,
    );
    console.log(`${LABEL} PASS`);
  } catch (error) {
    if (fs.existsSync(logFile)) {
      console.error(
        `${LABEL} log tail:\n${fs
          .readFileSync(logFile, "utf8")
          .split(/\r?\n/)
          .slice(-25)
          .join("\n")}`,
      );
    }
    throw error;
  } finally {
    await Promise.all(racers.map((racerClient) => racerClient.end().catch(() => undefined)));
    await blocker?.end().catch(() => undefined);
    await client?.end().catch(() => undefined);
    if (started) {
      spawnSync(path.join(bin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], {
        encoding: "utf8",
      });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...savedEnv };
    if (previousDatabaseUrl == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
