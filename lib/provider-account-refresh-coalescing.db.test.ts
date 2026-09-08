/**
 * IN-PROCESS REFRESH COALESCING, AGAINST A REAL POSTGRESQL.
 *
 * ── ROUND 24, ITEM 1 ────────────────────────────────────────────────────────
 * `runSnapshotRefresh` short-circuits two callers in the same process onto one
 * in-flight refresh. The entry was a bare `Promise<void>` keyed by
 * business/provider, and the joiner did:
 *
 *     await existingRequest.catch(() => undefined);
 *     return;
 *
 * Two defects lived in that line.
 *
 *   THE SWALLOWED FAILURE. The joiner RESOLVED even though the refresh it
 *   joined had failed, so `forceProviderAccountSnapshotRefresh` re-read the
 *   table and relabelled whatever it found `source: "live"`,
 *   `sourceHealth: "fresh"`, `refreshFailed: false`, `trustLevel: "safe"` --
 *   presenting a provider outage as a successful live refresh. The no-snapshot
 *   `resolveProviderAccountSnapshot` path had the same shape.
 *
 *   THE CROSSED GENERATION. The key names no generation, so a caller holding a
 *   credential from generation B adopted the outcome of a refresh started under
 *   generation A -- returning before ever reaching the durable, generation-bound
 *   refusal Round 23 built.
 *
 * These are facts about concurrency and about what the callers RETURN, so they
 * are proven through the public entry points -- `forceProviderAccountSnapshotRefresh`
 * and `resolveProviderAccountSnapshot` -- rather than against
 * `runSnapshotRefresh` internals.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import {
  getIntegration,
  providerConnectionGenerationTokenFromIntegration,
  upsertIntegration,
} from "@/lib/integrations";
import {
  ProviderAccountSnapshotRefreshError,
  forceProviderAccountSnapshotRefresh,
  resolveProviderAccountSnapshot,
  type ProviderAccountSnapshotItem,
} from "@/lib/provider-account-snapshots";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const NONCE = `${process.pid.toString(36)}${Date.now().toString(36)}`;

let ownerId = "";
let caseIndex = 0;

/** A fresh business + connected Meta integration per case, so no case inherits another's cooldown. */
async function newCase() {
  caseIndex += 1;
  const sql = getDb();
  const [business] = await sql<{ id: string }>`
    INSERT INTO businesses (name, owner_id)
    VALUES (${`coalescing seam ${caseIndex}`}, ${ownerId}) RETURNING id
  `;
  const businessId = business!.id;
  const account = `act_coal_${NONCE}_${caseIndex}`.slice(0, 60);
  await upsertIntegration({
    businessId,
    provider: "meta",
    status: "connected",
    providerAccountId: account,
    providerAccountName: "Coalescing seam",
    accessToken: `token-A-${caseIndex}`,
    tokenExpiresAt: new Date(Date.now() + 60 * 60_000),
    scopes: "ads_read",
  });
  return { businessId, account };
}

const generationOf = async (businessId: string) =>
  providerConnectionGenerationTokenFromIntegration(
    await getIntegration(businessId, "meta"),
  );

/** A loader that blocks until the test releases it, and counts its calls. */
function gatedLoader(accounts: ProviderAccountSnapshotItem[], outcome: "ok" | "fail") {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    get calls() {
      return calls;
    },
    arrived,
    release,
    loader: async () => {
      calls += 1;
      entered();
      await gate;
      if (outcome === "fail") throw new Error("provider exploded");
      return accounts;
    },
  };
}

describe.skipIf(!SEAM)("same-process refresh coalescing", () => {
  beforeAll(async () => {
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ??= `seam-key-${NONCE}`;
    const sql = getDb();
    const [owner] = await sql<{ id: string }>`
      INSERT INTO users (name, email, password_hash)
      VALUES ('coalescing seam', ${`coalescing-${NONCE}@example.invalid`}, 'unused')
      RETURNING id
    `;
    ownerId = owner!.id;
  });

  afterAll(async () => {
    const sql = getDb();
    await sql`DELETE FROM provider_accounts WHERE provider = 'meta' AND external_account_id LIKE ${`act_coal_${NONCE}_%`}`;
  });

  it("SAME generation, success: one provider call, both callers get the same success", async () => {
    const { businessId, account } = await newCase();
    const generation = await generationOf(businessId);
    const gated = gatedLoader(
      [{ id: account, name: "Coalescing seam", timezone: "Europe/Istanbul" }],
      "ok",
    );

    const first = forceProviderAccountSnapshotRefresh({
      businessId,
      provider: "meta",
      reason: "r24_same_generation_success_a",
      expectedConnectionGeneration: generation,
      liveLoader: gated.loader,
    });
    const second = forceProviderAccountSnapshotRefresh({
      businessId,
      provider: "meta",
      reason: "r24_same_generation_success_b",
      expectedConnectionGeneration: generation,
      liveLoader: gated.loader,
    });

    await gated.arrived;
    gated.release();
    const [a, b] = await Promise.all([first, second]);

    // Coalesced: the provider was asked exactly once.
    expect(gated.calls).toBe(1);
    expect(a.accounts.map((row) => row.id)).toEqual([account]);
    expect(b.accounts.map((row) => row.id)).toEqual([account]);
    // A genuine success may say so.
    expect(a.meta.source).toBe("live");
    expect(b.meta.source).toBe("live");
  }, 60_000);

  it("SAME generation, failure: EVERY caller rejects and none relabels the failure as live/fresh/safe", async () => {
    const { businessId } = await newCase();
    const generation = await generationOf(businessId);
    const gated = gatedLoader([], "fail");

    const first = forceProviderAccountSnapshotRefresh({
      businessId,
      provider: "meta",
      reason: "r24_same_generation_failure_a",
      expectedConnectionGeneration: generation,
      liveLoader: gated.loader,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const second = forceProviderAccountSnapshotRefresh({
      businessId,
      provider: "meta",
      reason: "r24_same_generation_failure_b",
      expectedConnectionGeneration: generation,
      liveLoader: gated.loader,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    await gated.arrived;
    gated.release();
    const results = await Promise.all([first, second]);

    expect(gated.calls).toBe(1);
    /*
      THE DEFECT, STATED AS AN ASSERTION. The joiner used to resolve, and its
      caller then relabelled the table's contents as a fresh, safe, live
      refresh. Both callers must fail, and the failure must be the structured
      one so the surface can say what happened.
    */
    for (const result of results) {
      expect(
        result.ok,
        `a caller reported success for a failed refresh: ${JSON.stringify(
          result.ok ? result.value.meta : null,
        )}`,
      ).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ProviderAccountSnapshotRefreshError);
      }
    }
  }, 60_000);

  it("SAME generation, failure, INITIAL resolve path: both callers reject rather than serving relabelled data", async () => {
    /*
      The other public entry point. With no snapshot row yet,
      `resolveProviderAccountSnapshot` refreshes and then returns -- so a
      swallowed joiner failure surfaced there too, as an empty-but-"fresh"
      answer instead of an error.
    */
    const { businessId } = await newCase();
    const generation = await generationOf(businessId);
    const gated = gatedLoader([], "fail");

    const settle = (promise: Promise<unknown>) =>
      promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const first = settle(
      resolveProviderAccountSnapshot({
        businessId,
        provider: "meta",
        reason: "r24_initial_resolve_a",
        expectedConnectionGeneration: generation,
        liveLoader: gated.loader,
      }),
    );
    const second = settle(
      resolveProviderAccountSnapshot({
        businessId,
        provider: "meta",
        reason: "r24_initial_resolve_b",
        expectedConnectionGeneration: generation,
        liveLoader: gated.loader,
      }),
    );

    await gated.arrived;
    gated.release();
    const results = await Promise.all([first, second]);

    expect(gated.calls).toBe(1);
    for (const result of results) {
      expect(result.ok, "the initial resolve path served a failed refresh").toBe(false);
    }
  }, 60_000);

  it("DIFFERENT generation: B waits for A, then runs its OWN loader, claim and commit", async () => {
    const { businessId, account } = await newCase();
    const generationA = await generationOf(businessId);
    const loaderA = gatedLoader(
      [{ id: account, name: "A list", timezone: "America/Los_Angeles" }],
      "ok",
    );

    const runA = forceProviderAccountSnapshotRefresh({
      businessId,
      provider: "meta",
      reason: "r24_generation_a",
      expectedConnectionGeneration: generationA,
      liveLoader: loaderA.loader,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // A is in flight, inside its provider call. The user reconnects.
    await loaderA.arrived;
    await upsertIntegration({
      businessId,
      provider: "meta",
      status: "connected",
      providerAccountId: account,
      providerAccountName: "Coalescing seam",
      accessToken: "token-B",
      tokenExpiresAt: new Date(Date.now() + 60 * 60_000),
      scopes: "ads_read",
    });
    const generationB = await generationOf(businessId);
    expect(generationB).not.toBe(generationA);

    const loaderB = gatedLoader(
      [{ id: account, name: "B list", timezone: "Asia/Tokyo" }],
      "ok",
    );
    const runB = forceProviderAccountSnapshotRefresh({
      businessId,
      provider: "meta",
      reason: "r24_generation_b",
      expectedConnectionGeneration: generationB,
      liveLoader: loaderB.loader,
    });

    /*
      B MUST NOT HAVE ADOPTED A'S IN-FLIGHT RESULT. While A is still blocked in
      its provider call, B has not called its own loader either -- it is waiting
      for A to settle, which is the contract: a different generation neither
      joins nor overtakes.
    */
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(loaderB.calls, "B joined A's refresh instead of waiting").toBe(0);

    loaderA.release();
    const aResult = await runA;
    // A's commit-time CAS refuses: the connection moved while it was fetching.
    expect(aResult.ok).toBe(false);

    await loaderB.arrived;
    loaderB.release();
    const bResult = await runB;

    // B did its OWN provider call...
    expect(loaderB.calls).toBe(1);
    // ...and its own commit landed, under its own generation.
    expect(bResult.accounts.map((row) => row.name)).toEqual(["B list"]);

    /*
      AND A'S REJECTION DID NOT MAKE A'S LIST SELECTABLE. The persisted account
      list is B's, not the one A fetched under the credential the user replaced.
    */
    const sql = getDb();
    const persisted = await sql<{ provider_account_name: string }>`
      SELECT item.provider_account_name
        FROM provider_account_snapshot_items item
        JOIN provider_account_snapshot_runs run ON run.id = item.snapshot_run_id
       WHERE run.business_id = ${businessId} AND run.provider = 'meta'
    `;
    expect(persisted.map((row) => row.provider_account_name)).toEqual(["B list"]);
  }, 90_000);
});
