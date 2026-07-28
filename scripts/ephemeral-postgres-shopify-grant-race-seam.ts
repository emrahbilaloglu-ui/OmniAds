/**
 * G1-G7 — the Shopify grant race ACROSS provider round trips, against a real
 * PostgreSQL.
 *
 * Registering the sync webhooks is a verify-then-create sequence: one list, then
 * one create per missing topic. Thirteen separate requests leave the process,
 * and the callers used to re-read the stored grant exactly ONCE, immediately
 * before the first of them. That covers the instant before request 1 and nothing
 * after it: a reconnect or a revoke landing between request 1 and request 2 left
 * every remaining create going out under a credential the business had already
 * replaced or withdrawn, and the function still returned a receipt that read as
 * complete success.
 *
 * The unit tests prove the guard is consulted before every request and that a
 * drift stops the rest. They prove it against an in-memory boolean, which is a
 * fake agreeing with itself. What has to be true is stronger: the authority the
 * guard re-reads is a ROW, the drift is another process COMMITTING an update to
 * that row, and the stop must happen because the real
 * `assertShopifyGrantUnchanged` read the real new value through the real
 * `getIntegration`.
 *
 * So this seam runs the real `registerShopifySyncWebhooks` and
 * `registerShopifyCustomerEventsPixel` against a real migrated database, with a
 * real connected `provider_connections` row, and performs a genuine committed
 * `UPDATE` from a SEPARATE `pg` client at the exact moment a provider request
 * resolves. Only the network is faked, and it is faked as a recorder: the proof
 * is the call log.
 *
 *   G1  no drift: every request is preceded by its own authority read, and the
 *       receipt is a complete registration
 *   G2  a committed reconnect as the LIST call resolves: zero creates
 *   G3  a committed reconnect as the FIRST create resolves: later creates absent,
 *       and the receipt names what did and did not happen
 *   G4  a committed REVOKE mid-sequence stops the rest
 *   G5  an authority read that genuinely FAILS stops the sequence rather than
 *       being treated as unchanged
 *   G6  the pixel path stops on a committed reconnect, and never reports a
 *       pixelId for a pixel it did not create
 *   G7  the guard is per-request, not per-sequence: moving the grant after the
 *       last create still leaves the completed work honestly described
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

import type { ShopifyGrantAuthority } from "@/lib/shopify/install-context";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB = "shopify_grant_race_seam";
const USER = "postgres";
const LABEL = "[shopify-grant-race-seam]";
const APP_URL = "https://grant-race.example.invalid";
const CALLBACK_URL = `${APP_URL}/api/webhooks/shopify/sync`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`shopify grant race seam FAILED: ${message}`);
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

type ProviderOperation =
  | "list_webhook_subscriptions"
  | "create_webhook_subscription"
  | "create_web_pixel"
  | "unknown";

/**
 * What left the process, recorded WITHOUT the request headers.
 *
 * The access token travels in `X-Shopify-Access-Token`, so the recorder never
 * looks at headers and the log can be printed in full.
 */
interface ProviderCall {
  operation: ProviderOperation;
  topic: string | null;
  shop: string;
}

/**
 * The network as a recorder, with a barrier.
 *
 * `onResolve` is awaited at the instant a request produces its response, so
 * "the grant moves as request N completes" is a committed database fact before
 * the sequence can reach request N+1. Nothing is timed and nothing sleeps.
 */
function installTransport(options: {
  existingTopics?: readonly string[];
  onResolve?: (call: ProviderCall, index: number) => Promise<void> | void;
}) {
  const calls: ProviderCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as { query?: string; variables?: Record<string, unknown> })
        : {};
    const query = String(body.query ?? "");
    const operation: ProviderOperation = query.includes("webhookSubscriptions(first:")
      ? "list_webhook_subscriptions"
      : query.includes("webhookSubscriptionCreate")
        ? "create_webhook_subscription"
        : query.includes("webPixelCreate")
          ? "create_web_pixel"
          : "unknown";
    const topic = body.variables?.topic;
    const call: ProviderCall = {
      operation,
      topic: typeof topic === "string" ? topic : null,
      shop: new URL(String(input)).host,
    };
    const index = calls.length;
    calls.push(call);

    // The barrier.
    await options.onResolve?.(call, index);

    const data =
      operation === "list_webhook_subscriptions"
        ? {
            webhookSubscriptions: {
              nodes: (options.existingTopics ?? []).map((existing) => ({
                id: `gid://shopify/WebhookSubscription/${existing}`,
                topic: existing,
                endpoint: {
                  __typename: "WebhookHttpEndpoint",
                  callbackUrl: CALLBACK_URL,
                },
              })),
            },
          }
        : operation === "create_web_pixel"
          ? {
              webPixelCreate: {
                userErrors: [],
                webPixel: { id: `gid://shopify/WebPixel/${index + 1}` },
              },
            }
          : { webhookSubscriptionCreate: { userErrors: [] } };

    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

function topicsCreated(calls: ProviderCall[]) {
  return calls
    .filter((call) => call.operation === "create_webhook_subscription")
    .map((call) => call.topic);
}

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-shopify-grant-race-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const realFetch = globalThis.fetch;
  let started = false;
  let client: Client | null = null;
  /** A SEPARATE backend, so every drift below is another process committing. */
  let mutator: Client | null = null;
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
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
      process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ??
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    // G6 registers a customer-events pixel, and registration legitimately
    // refuses when this secret is unset — the pixel would carry no token and
    // its events would be rejected. The seam never supplied it, so G6 only
    // passed where the ambient environment happened to have one. The repository
    // transfer removed that ambience and G6 began failing on an assertion about
    // Shopify grant races for a reason that has nothing to do with grant races.
    //
    // A seam that fabricates its own database, shop, token and transport must
    // fabricate this too. The refusal-when-unset path keeps its own coverage in
    // lib/shopify/pixels.test.ts, so nothing is weakened by making this
    // hermetic.
    process.env.SHOPIFY_CUSTOMER_EVENTS_SECRET =
      process.env.SHOPIFY_CUSTOMER_EVENTS_SECRET ??
      "sh_customer_events_grant_race_seam_secret";

    const db = await import("@/lib/db");
    resetDbClientCache = db.resetDbClientCache;
    db.resetDbClientCache();
    const { runMigrations } = await import("@/lib/migrations");
    await runMigrations({ force: true, reason: "shopify_grant_race_seam" });

    const { getIntegration, upsertIntegration } = await import("@/lib/integrations");
    const { assertShopifyGrantUnchanged, readShopifyGrantAuthority } = await import(
      "@/lib/shopify/install-context"
    );
    const { SHOPIFY_SYNC_WEBHOOK_TOPICS, registerShopifySyncWebhooks } = await import(
      "@/lib/shopify/webhooks"
    );
    const { registerShopifyCustomerEventsPixel } = await import("@/lib/shopify/pixels");
    const ALL_TOPICS = [...SHOPIFY_SYNC_WEBHOOK_TOPICS];

    client = new Client({ connectionString });
    await client.connect();
    mutator = new Client({ connectionString });
    await mutator.connect();

    const owner = await client.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Grant race', 'shopify-grant-race@example.invalid', 'unused')
       RETURNING id::text AS id`,
    );
    const ownerId = owner.rows[0]!.id;

    let businessSeq = 0;
    const makeBusiness = async () => {
      businessSeq += 1;
      return (
        await client!.query<{ id: string }>(
          `INSERT INTO businesses (name, owner_id) VALUES ($1, $2::uuid)
           RETURNING id::text AS id`,
          [`Grant race ${businessSeq}`, ownerId],
        )
      ).rows[0]!.id;
    };

    /**
     * A connected shop, and the authority a caller would capture from it — the
     * real row, read through the real accessor.
     */
    const connectShop = async (businessId: string, shopDomain: string) => {
      await upsertIntegration({
        businessId,
        provider: "shopify",
        status: "connected",
        providerAccountId: shopDomain,
        providerAccountName: shopDomain,
        accessToken: `shpat_seam_${businessSeq}`,
        scopes: "read_orders",
      });
      const row = await getIntegration(businessId, "shopify");
      const authority = row ? readShopifyGrantAuthority(row) : null;
      assert(authority, `setup: no usable grant authority for ${shopDomain}.`);
      return authority;
    };

    /**
     * The guard exactly as a caller must build it: the REAL
     * `assertShopifyGrantUnchanged`, which re-reads the connection row, wrapped
     * so a refusal throws. Invocations are counted to prove the guard runs once
     * per request rather than once per sequence.
     */
    const makeGuard = (businessId: string, authority: ShopifyGrantAuthority) => {
      const invocations: string[] = [];
      return {
        invocations,
        assertStillAuthorized: async () => {
          const check = await assertShopifyGrantUnchanged({ businessId, authority });
          invocations.push(check.ok ? "ok" : check.code);
          if (!check.ok) throw new Error(`${check.code}: ${check.detail}`);
        },
      };
    };

    /** A genuine committed reconnect, from the separate client. */
    const commitReconnect = async (businessId: string) => {
      const updated = await mutator!.query(
        `UPDATE provider_connections
            SET connection_generation = connection_generation + 1,
                updated_at = now()
          WHERE business_id = $1 AND provider = 'shopify'`,
        [businessId],
      );
      assert(updated.rowCount === 1, "drift: the reconnect UPDATE changed no row.");
    };

    /** A genuine committed revoke, from the separate client. */
    const commitRevoke = async (businessId: string) => {
      const updated = await mutator!.query(
        `UPDATE provider_connections
            SET status = 'disconnected', disconnected_at = now()
          WHERE business_id = $1 AND provider = 'shopify'`,
        [businessId],
      );
      assert(updated.rowCount === 1, "drift: the revoke UPDATE changed no row.");
    };

    const generationOf = async (businessId: string) =>
      (
        await client!.query<{ generation: string; status: string }>(
          `SELECT connection_generation::text AS generation, status
             FROM provider_connections
            WHERE business_id = $1 AND provider = 'shopify'`,
          [businessId],
        )
      ).rows[0]!;

    // ── G1. No drift: one authority read per request, complete receipt ───────
    const businessG1 = await makeBusiness();
    const authorityG1 = await connectShop(businessG1, "g1.myshopify.com");
    const guardG1 = makeGuard(businessG1, authorityG1);
    const callsG1 = installTransport({});
    const resultG1 = await registerShopifySyncWebhooks({
      shopId: authorityG1.shopDomain,
      accessToken: authorityG1.accessToken,
      assertStillAuthorized: guardG1.assertStillAuthorized,
    });
    assert(
      resultG1.status === "registered",
      `G1: an undisturbed registration did not report success: ${JSON.stringify(resultG1)}`,
    );
    assert(
      resultG1.status === "registered" &&
        resultG1.created.length === ALL_TOPICS.length &&
        resultG1.notCreated.length === 0,
      `G1: an undisturbed registration created ${JSON.stringify(topicsCreated(callsG1))}.`,
    );
    assert(
      callsG1.length === ALL_TOPICS.length + 1,
      `G1: expected 1 list + ${ALL_TOPICS.length} creates, saw ${callsG1.length} requests.`,
    );
    assert(
      guardG1.invocations.length === callsG1.length &&
        guardG1.invocations.every((entry) => entry === "ok"),
      `G1: ${guardG1.invocations.length} authority reads for ${callsG1.length} requests; the guard must run immediately before EACH one.`,
    );
    console.log(
      `${LABEL} G1 PASS per-request guard: an undisturbed registration sent ${callsG1.length} requests (1 list + ${ALL_TOPICS.length} creates) and performed ${guardG1.invocations.length} real authority re-reads against the connection row — one per request, not one per sequence`,
    );

    // ── G2. A committed reconnect as the LIST resolves: zero creates ────────
    const businessG2 = await makeBusiness();
    const authorityG2 = await connectShop(businessG2, "g2.myshopify.com");
    const guardG2 = makeGuard(businessG2, authorityG2);
    const callsG2 = installTransport({
      onResolve: async (_call, index) => {
        // Another process reconnects the business, committed, at the exact
        // moment request 1 answers.
        if (index === 0) await commitReconnect(businessG2);
      },
    });
    const resultG2 = await registerShopifySyncWebhooks({
      shopId: authorityG2.shopDomain,
      accessToken: authorityG2.accessToken,
      assertStillAuthorized: guardG2.assertStillAuthorized,
    });
    const generationG2 = await generationOf(businessG2);
    assert(
      generationG2.generation !== authorityG2.connectionGeneration.split(":")[0],
      "G2: the drift UPDATE did not actually change the stored generation.",
    );
    assert(
      callsG2.length === 1 && callsG2[0]!.operation === "list_webhook_subscriptions",
      `G2: ${callsG2.length} requests left the process after the grant moved: ${JSON.stringify(callsG2)}`,
    );
    assert(
      topicsCreated(callsG2).length === 0,
      `G2: subscriptions were created under a superseded credential: ${JSON.stringify(topicsCreated(callsG2))}`,
    );
    assert(
      resultG2.status === "stopped" &&
        resultG2.stoppedBefore === `create_webhook_subscription:${ALL_TOPICS[0]}` &&
        resultG2.created.length === 0 &&
        resultG2.notCreated.length === ALL_TOPICS.length,
      `G2: partial work was reported as success: ${JSON.stringify(resultG2)}`,
    );
    assert(
      resultG2.status === "stopped" && resultG2.reason.includes("generation"),
      `G2: the refusal was flattened into a generic error: ${JSON.stringify(resultG2)}`,
    );
    console.log(
      `${LABEL} G2 PASS drift after the list: a committed reconnect from a separate client while request 1 was answering stopped the sequence with 0 creates, 1 recorded request, and a receipt naming ${ALL_TOPICS.length} topics as not created`,
    );

    // ── G3. A committed reconnect as the FIRST create resolves ──────────────
    const businessG3 = await makeBusiness();
    const authorityG3 = await connectShop(businessG3, "g3.myshopify.com");
    const guardG3 = makeGuard(businessG3, authorityG3);
    const missingG3 = ALL_TOPICS.slice(0, 3);
    const callsG3 = installTransport({
      existingTopics: ALL_TOPICS.slice(3),
      onResolve: async (_call, index) => {
        if (index === 1) await commitReconnect(businessG3);
      },
    });
    const resultG3 = await registerShopifySyncWebhooks({
      shopId: authorityG3.shopDomain,
      accessToken: authorityG3.accessToken,
      assertStillAuthorized: guardG3.assertStillAuthorized,
    });
    assert(
      callsG3.length === 2,
      `G3: expected exactly the list and one create, saw ${JSON.stringify(callsG3)}`,
    );
    assert(
      JSON.stringify(topicsCreated(callsG3)) === JSON.stringify([missingG3[0]]),
      `G3: the requests that went out after the grant moved were ${JSON.stringify(topicsCreated(callsG3))}.`,
    );
    assert(
      !topicsCreated(callsG3).includes(missingG3[1]!) &&
        !topicsCreated(callsG3).includes(missingG3[2]!),
      `G3: a later create was still sent under the superseded credential.`,
    );
    assert(
      resultG3.status === "stopped" &&
        resultG3.stoppedBefore === `create_webhook_subscription:${missingG3[1]}` &&
        JSON.stringify(resultG3.created) === JSON.stringify([missingG3[0]]) &&
        JSON.stringify(resultG3.notCreated) === JSON.stringify(missingG3.slice(1)),
      `G3: the receipt does not name what did and did not happen: ${JSON.stringify(resultG3)}`,
    );
    assert(
      resultG3.status === "stopped" &&
        resultG3.verification !== null &&
        JSON.stringify(resultG3.verification.missingTopics) === JSON.stringify(missingG3),
      `G3: the stopped receipt lost the work plan it was executing.`,
    );
    console.log(
      `${LABEL} G3 PASS drift after the first create: a committed reconnect while create 1 was answering left exactly [${topicsCreated(callsG3).join(", ")}] created and [${resultG3.status === "stopped" ? resultG3.notCreated.join(", ") : ""}] never attempted, with no success receipt`,
    );

    // ── G4. A committed REVOKE mid-sequence ─────────────────────────────────
    const businessG4 = await makeBusiness();
    const authorityG4 = await connectShop(businessG4, "g4.myshopify.com");
    const guardG4 = makeGuard(businessG4, authorityG4);
    const missingG4 = ALL_TOPICS.slice(0, 2);
    const callsG4 = installTransport({
      existingTopics: ALL_TOPICS.slice(2),
      onResolve: async (_call, index) => {
        if (index === 1) await commitRevoke(businessG4);
      },
    });
    const resultG4 = await registerShopifySyncWebhooks({
      shopId: authorityG4.shopDomain,
      accessToken: authorityG4.accessToken,
      assertStillAuthorized: guardG4.assertStillAuthorized,
    });
    assert(
      (await generationOf(businessG4)).status === "disconnected",
      "G4: the revoke UPDATE did not actually disconnect the row.",
    );
    assert(
      callsG4.length === 2 && topicsCreated(callsG4).length === 1,
      `G4: a create was sent after the user disconnected the shop: ${JSON.stringify(callsG4)}`,
    );
    assert(
      resultG4.status === "stopped" &&
        resultG4.reason.includes("no longer connected") &&
        JSON.stringify(resultG4.notCreated) === JSON.stringify(missingG4.slice(1)),
      `G4: a revoked connection did not stop the sequence: ${JSON.stringify(resultG4)}`,
    );
    console.log(
      `${LABEL} G4 PASS revoke: a committed disconnect from a separate client while create 1 was answering stopped the remaining create, with the receipt naming [${resultG4.status === "stopped" ? resultG4.notCreated.join(", ") : ""}] as not created`,
    );

    // ── G5. An authority read that genuinely FAILS ──────────────────────────
    //
    // Not a moved grant — a grant nobody can currently read. The table the
    // credential lives in is renamed out from under the reader by another
    // committed statement, so `getIntegration` fails for real (42P01) and
    // `assertShopifyGrantUnchanged` reports `shopify_authority_unknown`. That
    // must stop the sequence: "I could not tell" is not "unchanged".
    const businessG5 = await makeBusiness();
    const authorityG5 = await connectShop(businessG5, "g5.myshopify.com");
    const guardG5 = makeGuard(businessG5, authorityG5);
    const missingG5 = ALL_TOPICS.slice(0, 2);
    let renamed = false;
    const callsG5 = installTransport({
      existingTopics: ALL_TOPICS.slice(2),
      onResolve: async (_call, index) => {
        if (index === 1) {
          await mutator!.query(
            `ALTER TABLE integration_credentials RENAME TO integration_credentials_seam_hidden`,
          );
          renamed = true;
        }
      },
    });
    const resultG5 = await registerShopifySyncWebhooks({
      shopId: authorityG5.shopDomain,
      accessToken: authorityG5.accessToken,
      assertStillAuthorized: guardG5.assertStillAuthorized,
    });
    if (renamed) {
      await mutator.query(
        `ALTER TABLE integration_credentials_seam_hidden RENAME TO integration_credentials`,
      );
    }
    assert(
      guardG5.invocations.includes("shopify_authority_unknown"),
      `G5: an unreadable authority was not classified as unknown: ${JSON.stringify(guardG5.invocations)}`,
    );
    assert(
      callsG5.length === 2 && topicsCreated(callsG5).length === 1,
      `G5: the sequence continued while the grant could not be read: ${JSON.stringify(callsG5)}`,
    );
    assert(
      resultG5.status === "stopped" &&
        resultG5.stoppedBefore === `create_webhook_subscription:${missingG5[1]}` &&
        JSON.stringify(resultG5.created) === JSON.stringify([missingG5[0]]),
      `G5: a failed authority read was treated as unchanged: ${JSON.stringify(resultG5)}`,
    );
    console.log(
      `${LABEL} G5 PASS unreadable authority: a real read failure mid-sequence (${guardG5.invocations.filter((entry) => entry !== "ok").join(", ")}) stopped the remaining create instead of passing as unchanged`,
    );

    // ── G6. The pixel path ──────────────────────────────────────────────────
    const businessG6 = await makeBusiness();
    const authorityG6 = await connectShop(businessG6, "g6.myshopify.com");
    const guardG6 = makeGuard(businessG6, authorityG6);
    const callsG6 = installTransport({});
    const pixelBefore = await registerShopifyCustomerEventsPixel({
      shopId: authorityG6.shopDomain,
      accessToken: authorityG6.accessToken,
      assertStillAuthorized: guardG6.assertStillAuthorized,
    });
    assert(
      pixelBefore.status === "registered" && callsG6.length === 1,
      `G6: the undisturbed pixel registration did not happen: ${JSON.stringify(pixelBefore)}`,
    );
    // A committed reconnect, then the very next attempt.
    await commitReconnect(businessG6);
    const pixelAfter = await registerShopifyCustomerEventsPixel({
      shopId: authorityG6.shopDomain,
      accessToken: authorityG6.accessToken,
      assertStillAuthorized: guardG6.assertStillAuthorized,
    });
    assert(
      callsG6.length === 1,
      `G6: a pixel was created under a credential the business had replaced: ${JSON.stringify(callsG6)}`,
    );
    assert(
      pixelAfter.status === "stopped" &&
        pixelAfter.notCreated.length === 1 &&
        pixelAfter.created.length === 0 &&
        !("pixelId" in pixelAfter),
      `G6: a stopped pixel registration reported a pixel: ${JSON.stringify(pixelAfter)}`,
    );
    console.log(
      `${LABEL} G6 PASS pixel path: a committed reconnect between two attempts left the web-pixel request count at ${callsG6.length}, and the refused attempt carries no pixelId to be recorded as a completed registration`,
    );

    // ── G7. Drift after the LAST create is still described honestly ─────────
    //
    // The sequence has no request left to stop, so the receipt must report the
    // registration it genuinely completed — a stop is only correct when work
    // was actually withheld.
    const businessG7 = await makeBusiness();
    const authorityG7 = await connectShop(businessG7, "g7.myshopify.com");
    const guardG7 = makeGuard(businessG7, authorityG7);
    const callsG7 = installTransport({
      existingTopics: ALL_TOPICS.slice(1),
      onResolve: async (_call, index) => {
        if (index === 1) await commitReconnect(businessG7);
      },
    });
    const resultG7 = await registerShopifySyncWebhooks({
      shopId: authorityG7.shopDomain,
      accessToken: authorityG7.accessToken,
      assertStillAuthorized: guardG7.assertStillAuthorized,
    });
    assert(
      resultG7.status === "registered" &&
        JSON.stringify(resultG7.created) === JSON.stringify([ALL_TOPICS[0]]) &&
        resultG7.notCreated.length === 0,
      `G7: a fully completed registration was not reported as complete: ${JSON.stringify(resultG7)}`,
    );
    assert(
      callsG7.length === 2 && guardG7.invocations.length === 2,
      `G7: unexpected request or guard count: ${callsG7.length}/${guardG7.invocations.length}`,
    );
    console.log(
      `${LABEL} G7 PASS honest completion: a reconnect landing after the last create leaves a genuine 'registered' receipt with created=[${resultG7.status === "registered" ? resultG7.created.join(", ") : ""}] and nothing withheld`,
    );

    // No credential material may appear in anything this seam printed or
    // returned.
    const allReceipts = JSON.stringify([
      resultG1,
      resultG2,
      resultG3,
      resultG4,
      resultG5,
      resultG7,
      pixelBefore,
      pixelAfter,
      callsG1,
      callsG2,
      callsG3,
      callsG4,
      callsG5,
      callsG6,
      callsG7,
    ]);
    assert(
      !allReceipts.includes("shpat_"),
      "G7: a receipt or a recorded call carried access-token material.",
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
    globalThis.fetch = realFetch;
    await client?.end().catch(() => undefined);
    await mutator?.end().catch(() => undefined);
    resetDbClientCache?.();
    if (started) {
      spawnSync(path.join(bin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], {
        encoding: "utf8",
      });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (previousDatabaseUrl == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousAppUrl == null) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = previousAppUrl;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
