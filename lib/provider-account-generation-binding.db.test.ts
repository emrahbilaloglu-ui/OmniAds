/**
 * A TIMEZONE RECONCILIATION MAY ONLY BE AUTHORISED BY THE GRANT IT WAS FETCHED
 * UNDER — PROVEN AGAINST A REAL POSTGRESQL.
 *
 * ── ROUND 23 ────────────────────────────────────────────────────────────────
 * Round 22 stopped ORDINARY writes from moving `provider_accounts.timezone` and
 * left exactly one path able to move it: a fresh provider profile committed
 * under the connection-generation CAS. Two holes remained in "fresh".
 *
 *   ITEM 1 — the manual Meta refresh route read the integration record, called
 *   Meta with that token, and then refreshed WITHOUT saying which generation
 *   the token belonged to. `runSnapshotRefresh` adopted whatever generation
 *   existed by the time it claimed, so a reconnect landing in that window let
 *   the OLD token's account list, and its timezones, commit under the NEW
 *   grant.
 *
 *   ITEM 2 — the commit-time CAS read `provider_connections` through a LEFT
 *   JOIN but locked `FOR UPDATE OF run` only. `upsertIntegration` locks the
 *   connection in its own transaction, so a reconnect could commit between the
 *   generation check passing and the timezone write a few statements later in
 *   the SAME transaction.
 *
 * Both are facts about database serialization, so both are proven here with
 * real clients rather than argued from code shape.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "pg";

import { getDb } from "@/lib/db";
import {
  getIntegration,
  providerConnectionGenerationTokenFromIntegration,
  upsertIntegration,
} from "@/lib/integrations";
import {
  ProviderAccountSnapshotRefreshError,
  forceProviderAccountSnapshotRefresh,
} from "@/lib/provider-account-snapshots";
import { refreshProviderDiscoveryPayload } from "@/lib/provider-account-discovery-refresh";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const NONCE = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const OWNER_EMAIL = `gen-binding-${NONCE}@example.invalid`;
const ACCOUNT = `act_gen_${NONCE}`.slice(0, 60);
const BOUND = "America/Los_Angeles";
/** The value only the phase-3 reconciliation writes; the barrier keys on it. */
const FRESH_TIMEZONE = "Asia/Tokyo";

let businessId = "";

/**
 * Poll a real database condition until it holds.
 *
 * Deliberately not a sleep. A sleep asserts "enough time passed"; this asserts
 * "the database reached this state", and fails loudly if it never does.
 */
async function waitFor<T>(
  probe: () => Promise<T | null | false>,
  failure: string,
  timeoutMs = 20_000,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value === true ? null : (value as T);
    if (Date.now() > deadline) throw new Error(failure);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const timezoneOf = async () => {
  const sql = getDb();
  const rows = await sql<{ timezone: string | null }>`
    SELECT timezone FROM provider_accounts
     WHERE provider = 'meta' AND external_account_id = ${ACCOUNT}
  `;
  return rows[0]?.timezone ?? null;
};

const setBoundTimezone = async (timezone: string) => {
  const sql = getDb();
  await sql`
    UPDATE provider_accounts SET timezone = ${timezone}
     WHERE provider = 'meta' AND external_account_id = ${ACCOUNT}
  `;
};

const connectMeta = (accessToken: string) =>
  upsertIntegration({
    businessId,
    provider: "meta",
    status: "connected",
    providerAccountId: ACCOUNT,
    providerAccountName: "Generation binding seam",
    accessToken,
    tokenExpiresAt: new Date(Date.now() + 60 * 60_000),
    scopes: "ads_read",
  });

const capturedGeneration = async () =>
  providerConnectionGenerationTokenFromIntegration(
    await getIntegration(businessId, "meta"),
  );

describe.skipIf(!SEAM)("the fresh-profile reconcile is bound to its grant", () => {
  beforeAll(async () => {
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ??= `seam-key-${NONCE}`;
    const sql = getDb();
    const [owner] = await sql<{ id: string }>`
      INSERT INTO users (name, email, password_hash)
      VALUES ('gen binding seam', ${OWNER_EMAIL}, 'unused') RETURNING id
    `;
    const [business] = await sql<{ id: string }>`
      INSERT INTO businesses (name, owner_id)
      VALUES ('gen binding seam', ${owner!.id}) RETURNING id
    `;
    businessId = business!.id;
    await connectMeta("token-A");
    await setBoundTimezone(BOUND);
    expect(await timezoneOf()).toBe(BOUND);
  });

  afterAll(async () => {
    const sql = getDb();
    await sql`DELETE FROM provider_accounts WHERE provider = 'meta' AND external_account_id = ${ACCOUNT}`;
  });

  it("ITEM 1: REJECTS a refresh whose credential predates the current grant, and leaves the binding alone", async () => {
    /*
      The exact production sequence the route ran: read the integration record
      (token + generation A), then refresh. A reconnect lands in between.
    */
    const generationA = await capturedGeneration();
    expect(generationA).toBeTruthy();

    // The reconnect. Generation A -> B, committed before the refresh claims.
    await connectMeta("token-B");
    const generationB = await capturedGeneration();
    expect(generationB).not.toBe(generationA);

    let loaderCalls = 0;
    const refusal = await refreshProviderDiscoveryPayload({
      businessId,
      provider: "meta",
      reason: "r23_stale_generation_manual_refresh",
      // Captured with the token, from the SAME record — which is the fix.
      expectedConnectionGeneration: generationA,
      liveLoader: async () => {
        loaderCalls += 1;
        return [
          { id: ACCOUNT, name: "Generation binding seam", timezone: "Europe/Istanbul" },
        ];
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(ProviderAccountSnapshotRefreshError);
    /*
      And the provider was never called. A refusal that still spent the request
      would leak an old token's read to the provider before discarding it.
    */
    expect(loaderCalls).toBe(0);
    // The binding is untouched: no A-derived timezone landed under grant B.
    expect(await timezoneOf()).toBe(BOUND);
  });

  it("ITEM 1: REJECTS a refresh that names NO generation while a connection exists", async () => {
    /*
      THE OLD ROUTE, EXACTLY. It supplied nothing, so the module saw `null` and
      the comparison -- `expected != null && expected !== claimed` -- skipped
      itself, adopting whatever generation was current at claim time.

      `null` is now a claim like any other: it says "there was no connection
      when I read the credential". A connection that exists contradicts it, so
      the refresh is refused rather than silently re-authorised.
    */
    let loaderCalls = 0;
    const refusal = await refreshProviderDiscoveryPayload({
      businessId,
      provider: "meta",
      reason: "r23_unnamed_generation_manual_refresh",
      expectedConnectionGeneration: null,
      liveLoader: async () => {
        loaderCalls += 1;
        return [
          { id: ACCOUNT, name: "Generation binding seam", timezone: "Europe/Istanbul" },
        ];
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(ProviderAccountSnapshotRefreshError);
    expect(loaderCalls).toBe(0);
    expect(await timezoneOf()).toBe(BOUND);
  });

  it("ITEM 1 control: the SAME refresh reconciles when its generation is current", async () => {
    /*
      The discriminator. Without this the refusal above could be produced by any
      broken refresh, and the binding would be "unchanged" for the wrong reason.
    */
    const generation = await capturedGeneration();
    let loaderCalls = 0;
    const payload = await refreshProviderDiscoveryPayload({
      businessId,
      provider: "meta",
      reason: "r23_current_generation_manual_refresh",
      expectedConnectionGeneration: generation,
      liveLoader: async () => {
        loaderCalls += 1;
        return [
          { id: ACCOUNT, name: "Generation binding seam", timezone: "Europe/Istanbul" },
        ];
      },
    });

    expect(loaderCalls).toBe(1);
    expect(payload.data.length).toBeGreaterThan(0);
    // A genuinely fresh, CAS-protected profile MAY move the binding.
    expect(await timezoneOf()).toBe("Europe/Istanbul");
    await setBoundTimezone(BOUND);
  });

  it("ITEM 2: a reconnect cannot interleave inside the production commit transaction", async () => {
    /*
      ── ROUND 24, ITEM 2 ──────────────────────────────────────────────────────

      The previous version of this case composed the exported CAS helper and the
      reference-store helper by hand and inferred the block from a 750 ms sleep.
      Two ways it could pass while the system was broken: the reconnect might
      never have reached the lock at all, and the assertion said nothing about
      where the REAL success persistence runs -- move it outside the CAS
      transaction and the hand-composed version stayed green.

      This drives the ACTUAL production path: `forceProviderAccountSnapshotRefresh`
      claims, fetches, and commits through `runSnapshotRefresh` phase 3, which is
      where the CAS and the `provider_accounts` reconciliation must share one
      transaction.

      The barrier is a temporary BEFORE-UPDATE trigger on the real
      `provider_accounts` row, taking a transaction advisory lock the test holds
      from its own connection. The production transaction therefore parks
      EXACTLY at its timezone write, still holding whatever locks it took -- and
      nothing about the test's timing decides that.

      Nothing is inferred from elapsed time: the reconnect's own backend is
      observed in `pg_stat_activity` / `pg_blocking_pids`, waiting on a lock,
      with `provider_connections ... FOR UPDATE` as its current query, before the
      barrier is released.
    */
    await setBoundTimezone(BOUND);
    const generation = await capturedGeneration();
    const barrierKey = (process.pid % 100000) + 4200000;

    const barrierHolder = new Client({ connectionString: process.env.DATABASE_URL });
    await barrierHolder.connect();
    const sql = getDb();
    try {
      // The test owns the barrier before any production code can reach it.
      await barrierHolder.query("SELECT pg_advisory_lock($1)", [barrierKey]);
      await sql.query(`
        CREATE OR REPLACE FUNCTION r24_provider_accounts_barrier() RETURNS trigger
        LANGUAGE plpgsql AS $barrier$
        BEGIN
          /*
            Gated on the FRESHLY FETCHED timezone, not merely on the account.

            runSnapshotRefresh writes provider_accounts twice: phase 1
            REPLAYS the stored account list while taking its durable claim, and
            phase 3 reconciles the list this refresh actually fetched. Only
            phase 3 runs inside the transaction that holds the connection-row
            lock, so a barrier that fires on the account alone parks the CLAIM
            transaction -- which holds no such lock -- and the reconnect below
            sails past. That is precisely the vacuous pass this case exists to
            rule out, and it is why the value is part of the predicate.
          */
          IF NEW.external_account_id = ${"'"}${ACCOUNT}${"'"}
             AND NEW.timezone = ${"'"}${FRESH_TIMEZONE}${"'"} THEN
            PERFORM pg_advisory_xact_lock(${barrierKey});
          END IF;
          RETURN NEW;
        END
        $barrier$
      `);
      await sql.query(`
        CREATE TRIGGER r24_provider_accounts_barrier_trigger
        BEFORE INSERT OR UPDATE ON provider_accounts
        FOR EACH ROW EXECUTE FUNCTION r24_provider_accounts_barrier()
      `);

      const order: string[] = [];
      const refresh = forceProviderAccountSnapshotRefresh({
        businessId,
        provider: "meta",
        reason: "r24_production_commit_interleave",
        expectedConnectionGeneration: generation,
        liveLoader: async () => [
          { id: ACCOUNT, name: "Generation binding seam", timezone: FRESH_TIMEZONE },
        ],
      }).then(
        () => {
          order.push("A:refresh-committed");
          return { ok: true as const };
        },
        (error: unknown) => {
          order.push("A:refresh-failed");
          return { ok: false as const, error };
        },
      );

      // 1. Wait for the production transaction to REACH the timezone write.
      await waitFor(
        async () =>
          (
            await sql.query<{ total: string }>(
              `SELECT count(*)::text AS total FROM pg_stat_activity
                WHERE datname = current_database()
                  AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
            )
          )[0]!.total !== "0",
        "the production refresh never reached the provider_accounts write",
      );

      // 2. Only now does the user reconnect, through the real writer.
      let reconnectSettled = false;
      const reconnect = connectMeta("token-D").then(() => {
        reconnectSettled = true;
        order.push("B:reconnect-committed");
      });

      /*
        3. OBSERVED, NOT ASSUMED. The reconnect's backend must be blocked, and
        blocked on `provider_connections ... FOR UPDATE` specifically. Without
        the connection-row lock in the CAS -- or with the persistence moved out
        of that transaction -- this never becomes true and the case fails here
        rather than sleeping past the question.
      */
      const blocked = await waitFor(
        async () => {
        const rows = await sql.query<{ query: string; blocked_by: string }>(
          `SELECT query, cardinality(pg_blocking_pids(pid))::text AS blocked_by
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND cardinality(pg_blocking_pids(pid)) > 0
              AND query ILIKE '%provider_connections%'
              AND query ILIKE '%FOR UPDATE%'`,
        );
        return rows.length > 0 ? rows : null;
        },
        "the reconnect never blocked on the connection row lock",
        // Deliberately shorter than the pool's 8s statement timeout: past that
        // the parked production statement is cancelled and its locks released,
        // so a longer wait would be measuring the timeout, not the lock.
        5_000,
      );
      expect(blocked!.length).toBeGreaterThan(0);
      expect(reconnectSettled, "the reconnect committed before the refresh did").toBe(
        false,
      );

      // 4. Release the barrier; the production transaction commits.
      await barrierHolder.query("SELECT pg_advisory_unlock($1)", [barrierKey]);
      const refreshResult = await refresh;
      await reconnect;

      expect(refreshResult.ok, JSON.stringify(refreshResult)).toBe(true);
      // The production commit landed FIRST, under the generation it validated.
      expect(order).toEqual(["A:refresh-committed", "B:reconnect-committed"]);
      // Its reconciliation is the value that survives...
      expect(await timezoneOf()).toBe(FRESH_TIMEZONE);
      // ...and the reconnect really happened, so this is serialization rather
      // than a reconnect that never ran.
      expect(await capturedGeneration()).not.toBe(generation);
    } finally {
      /*
        Released FIRST. Dropping the trigger needs ACCESS EXCLUSIVE on
        `provider_accounts`, which a still-parked production transaction holds --
        so cleaning up in the other order deadlocks the failure path.
      */
      await barrierHolder.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      await barrierHolder.end().catch(() => undefined);
      await sql
        .query("DROP TRIGGER IF EXISTS r24_provider_accounts_barrier_trigger ON provider_accounts")
        .catch(() => undefined);
      await sql
        .query("DROP FUNCTION IF EXISTS r24_provider_accounts_barrier()")
        .catch(() => undefined);
      await setBoundTimezone(BOUND);
    }
  }, 90_000);
});
