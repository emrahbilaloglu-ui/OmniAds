/**
 * THE BOOTSTRAP LIFECYCLE THROUGH THE SHIPPED ORCHESTRATION.
 *
 * ── ROUND 19, ITEMS A1 AND A2 ───────────────────────────────────────────────
 * The previous "lifecycle" proof called the decision function, INSERTed a sync
 * run by hand, and called `persistMetaEntityObservation` directly — three steps
 * a test author chose, in an order a test author chose. That shows the pieces
 * work; it cannot show the shipped orchestration wires them together, which is
 * the only thing at issue.
 *
 * This drives the REAL `syncMetaPartitionDay`. Only the Graph fetch is stubbed;
 * coverage is read from real daily rows, the bootstrap decision, the ledger
 * claim, the core refetch and the receipt writes are all production code, and
 * the receipts are read back from the database.
 *
 * THE DISCRIMINATING SETUP (item A1). The DB binding says America/Los_Angeles
 * and the credential profile says Europe/Istanbul. Those are different
 * calendars, so a run that still derives `accountToday` from the credential
 * profile computes a different provider-local day from the one that decided
 * truthState and bootstrap eligibility — and the current-evidence gate then
 * refuses to write config receipts on the very day the bootstrap paid to
 * refetch.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db";
import { __syncMetaPartitionDayForSeams } from "@/lib/sync/meta-sync";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const NONCE = `${process.pid}${Date.now().toString(36)}`;
const ACCOUNT = `act_orch_${NONCE}`.slice(0, 60);
const OWNER_EMAIL = `authority-orchestration-${NONCE}@example.invalid`;

/**
 * ── ROUND 21, ITEM 1: AN INSTANT AT WHICH THE TWO CALENDARS PROVABLY DIFFER ──
 *
 * The discriminator in this file is that the DB binding says
 * America/Los_Angeles while the credential profile says Europe/Istanbul. On
 * the real clock those two zones are on the SAME calendar date for most of any
 * given day, so `referenceToday === LA_TODAY` passed no matter which source
 * the orchestration had actually read. It was not a discriminator; it was a
 * coincidence that usually held.
 *
 * At 04:00 UTC they can never agree. Los Angeles is UTC-8 or UTC-7, so 04:00Z
 * is 20:00 or 21:00 of the PREVIOUS calendar day there; Istanbul has been a
 * fixed UTC+3 with no DST since 2016, so the same instant is 07:00 of the
 * SAME day. The gap is structural, not seasonal, and `EXPECTED_DIFFERENT_DAYS`
 * below asserts it rather than trusting this paragraph.
 *
 * WHY THE INSTANT IS DERIVED RATHER THAN A FIXED LITERAL. A literal in the
 * past cannot work: the receipts this seam reads back are written by
 * production code at the real database clock, and the bootstrap probe bounds
 * its evidence at `min(evaluationNow, provider-local day end)`. A past instant
 * puts every receipt the first run wrote OUTSIDE that bound, the probe reports
 * nothing linked, and the second run claims a second bootstrap attempt -- the
 * fixture, not the code, would have broken the test. A literal far in the
 * FUTURE fails the other way: freshness is measured from `observedAt` to the
 * bound, so a bound months ahead makes those same receipts read as stale.
 *
 * The instant is therefore the next 04:00 UTC strictly after the run: always
 * within 24 hours, so freshness holds, and always after the writes, so the
 * bound contains them. The property under test -- two different calendar days
 * -- is guaranteed by construction and asserted explicitly below.
 */
const SEAM_INSTANT = (() => {
  const now = new Date();
  const todayAt04 = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      4,
      0,
      0,
      0,
    ),
  );
  return todayAt04.getTime() > now.getTime()
    ? todayAt04
    : new Date(todayAt04.getTime() + 24 * 60 * 60 * 1000);
})();

const calendarDateIn = (timeZone: string, instant: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);

/** The account's own today in Los Angeles, which is what everything must agree on. */
const LA_TODAY = calendarDateIn("America/Los_Angeles", SEAM_INSTANT);
/** What the CREDENTIAL profile's zone would have called the same instant. */
const ISTANBUL_TODAY = calendarDateIn("Europe/Istanbul", SEAM_INSTANT);

let businessId = "";
let accountRefId = "";
let partitionId = "";

/** Every Graph URL the core day may reach, answered with an empty-but-valid page. */
function stubGraph() {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/**
 * Daily rows for LA-today, so `productCoreComplete` reads TRUE from the DB.
 *
 * NOT swallowed. An earlier revision wrapped these in `.catch(() => undefined)`
 * and the inserts failed silently on the NOT NULL `account_timezone` /
 * `account_currency` columns — so coverage stayed INCOMPLETE, the core sync ran
 * for the ordinary reason rather than because of a bootstrap, and the case
 * asserted zero ledger rows while appearing to test the bootstrap.
 */
async function seedCompleteCoverage() {
  const sql = getDb();
  /*
    ── ROUND 21, ITEM 1: RESTORATIVE, NOT FIRST-WRITE-ONLY ───────────────────
    These were `ON CONFLICT DO NOTHING`, which made a second call a no-op. The
    second call now has to actually restore the row, so the rows are replaced
    outright for this account and day.
  */
  await sql`DELETE FROM meta_account_daily
             WHERE business_id = ${businessId} AND provider_account_id = ${ACCOUNT}`;
  await sql`DELETE FROM meta_campaign_daily
             WHERE business_id = ${businessId} AND provider_account_id = ${ACCOUNT}`;
  await sql`DELETE FROM meta_adset_daily
             WHERE business_id = ${businessId} AND provider_account_id = ${ACCOUNT}`;
  await sql`
    INSERT INTO meta_account_daily (
      business_id, provider_account_id, date, account_timezone, account_currency,
      spend, impressions, clicks, conversions, revenue
    ) VALUES (
      ${businessId}, ${ACCOUNT}, ${LA_TODAY}::date, 'America/Los_Angeles', 'USD',
      100, 1000, 20, 5, 500
    )
  `;
  await sql`
    INSERT INTO meta_campaign_daily (
      business_id, provider_account_id, campaign_id, date, account_timezone,
      account_currency, spend, impressions, clicks, conversions, revenue
    ) VALUES (
      ${businessId}, ${ACCOUNT}, 'cmp_orch', ${LA_TODAY}::date,
      'America/Los_Angeles', 'USD', 100, 1000, 20, 5, 500
    )
  `;
  await sql`
    INSERT INTO meta_adset_daily (
      business_id, provider_account_id, campaign_id, adset_id, date,
      account_timezone, account_currency, spend, impressions, clicks,
      conversions, revenue
    ) VALUES (
      ${businessId}, ${ACCOUNT}, 'cmp_orch', 'ads_orch', ${LA_TODAY}::date,
      'America/Los_Angeles', 'USD', 100, 1000, 20, 5, 500
    )
  `;
  // Proven, not assumed: the whole point of the fixture is that coverage is
  // COMPLETE, and a silent failure here makes every assertion below vacuous.
  const [counts] = await sql<{ acct: string; camp: string; adset: string }>`
    SELECT
      (SELECT count(*) FROM meta_account_daily
        WHERE business_id = ${businessId} AND provider_account_id = ${ACCOUNT}) AS acct,
      (SELECT count(*) FROM meta_campaign_daily
        WHERE business_id = ${businessId} AND provider_account_id = ${ACCOUNT}) AS camp,
      (SELECT count(*) FROM meta_adset_daily
        WHERE business_id = ${businessId} AND provider_account_id = ${ACCOUNT}) AS adset
  `;
  if (
    Number(counts!.acct) < 1 ||
    Number(counts!.camp) < 1 ||
    Number(counts!.adset) < 1
  ) {
    throw new Error(
      `coverage fixture did not land: ${JSON.stringify(counts)} — every assertion would be vacuous`,
    );
  }
}

/** A LEGACY receipt: complete, but with no attempt link. */
async function seedLegacyReceipts() {
  const sql = getDb();
  for (const [entityType, endpoint] of [
    ["campaign", "campaign_configs"],
    ["adset", "adset_configs"],
  ] as const) {
    const [obs] = await sql<{ id: string }>`
      INSERT INTO meta_entity_observation_runs (
        business_ref_id, business_id, provider_account_ref_id,
        provider_account_id, entity_type, endpoint, observed_at, captured_at,
        completeness, page_count, row_count, run_hash
      ) VALUES (
        ${businessId}::uuid, ${businessId}, ${accountRefId}::uuid, ${ACCOUNT},
        ${entityType}, ${endpoint}, now() - interval '2 hours',
        now() - interval '2 hours', 'complete', 1, 0,
        ${`${NONCE}${entityType}`.padStart(64, "0").slice(-64).replace(/[^0-9a-f]/g, "a")}
      ) RETURNING id
    `;
    await sql`
      INSERT INTO meta_entity_observation_receipts (
        run_id, business_id, provider_account_id, entity_type, endpoint,
        partition_id, sync_run_id, capture_status, provider_row_count,
        page_count, run_reused, observed_at, captured_at
      ) VALUES (
        ${obs!.id}::uuid, ${businessId}, ${ACCOUNT}, ${entityType}, ${endpoint},
        ${partitionId}::uuid, NULL, 'complete', 0, 1, false,
        now() - interval '2 hours', now() - interval '2 hours'
      )
    `;
  }
}

const credentials = () =>
  ({
    businessId,
    accessToken: "token",
    accountIds: [ACCOUNT],
    currency: "USD",
    accountProfiles: {
      // DELIBERATELY DIFFERENT from the DB binding.
      [ACCOUNT]: { currency: "USD", timezone: "Europe/Istanbul", name: "Orch" },
    },
  }) as never;

const runPartitionDay = (syncRunId: string) =>
  __syncMetaPartitionDayForSeams({
    // The narrow seam clock. Only `resolveMetaPartitionDateAuthority` and the
    // bootstrap decision read it; nothing else in the pipeline is faked, and
    // the database keeps its own real `now()`.
    evaluationNow: SEAM_INSTANT,
    credentials: credentials(),
    businessId,
    providerAccountId: ACCOUNT,
    day: LA_TODAY,
    lane: "core",
    partitionScope: "account_daily",
    source: "today",
    scopes: ["account_daily"],
    partitionId,
    syncRunId,
    workerId: "seam-worker",
    leaseEpoch: 1,
    attemptCount: 0,
  } as never);

/**
 * A sync attempt in its RUNNING state, exactly as `processMetaPartition` opens
 * one before doing any work.
 *
 * Deliberately not pre-finished. The recent-edit authority requires the receipt
 * occurrence to fall INSIDE the attempt's lifecycle, and a run stamped
 * `finished_at = now()` before the work begins finishes before its own
 * receipts — which is a real lifecycle mismatch, not a test artefact. The run
 * is settled by `finishSyncRun` after the partition day returns.
 */
async function newSyncRun() {
  const sql = getDb();
  const [run] = await sql<{ id: string }>`
    INSERT INTO meta_sync_runs (
      partition_id, business_id, business_ref_id, provider_account_id,
      provider_account_ref_id, lane, scope, partition_date, status,
      attempt_count, started_at
    ) VALUES (
      ${partitionId}::uuid, ${businessId}, ${businessId}::uuid, ${ACCOUNT},
      ${accountRefId}::uuid, 'core', 'core_warehouse', ${LA_TODAY}::date,
      'running', 1, now() - interval '1 minute'
    ) RETURNING id
  `;
  return run!.id;
}

/** Settle the attempt the way the orchestrator does once the work is done. */
async function finishSyncRun(runId: string) {
  const sql = getDb();
  await sql`
    UPDATE meta_sync_runs
       SET status = 'succeeded', finished_at = now(), updated_at = now()
     WHERE id = ${runId}::uuid
  `;
}

const ledgerRows = async () => {
  const sql = getDb();
  const rows = await sql<{ total: string }>`
    SELECT count(*)::text AS total FROM meta_authority_bootstrap_attempts
    WHERE business_id = ${businessId} AND provider_account_id = ${ACCOUNT}
  `;
  return Number(rows[0]!.total);
};

const linkedReceipts = async () => {
  const sql = getDb();
  return sql<{ endpoint: string; sync_run_id: string }>`
    SELECT endpoint, sync_run_id::text AS sync_run_id
    FROM meta_entity_observation_receipts
    WHERE business_id = ${businessId}
      AND provider_account_id = ${ACCOUNT}
      AND sync_run_id IS NOT NULL
    ORDER BY endpoint
  `;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/*
  ── ROUND 20, ITEM 1: WHY THIS WAS SKIPPED, AND WHAT IT PROVED ───────────────

  Round 19 left these skipped with a pinned discrepancy:
  `syncMetaPartitionDay` reported `beforeCoverage.productCoreComplete === false`
  for the same business/account/day where the raw coverage readers returned
  `completed_days: 1`.

  The discrepancy was real and the cause was `getMetaDailyCoverageState`. Under
  authoritative-finalization V2 it asked `getMetaPublishedVerificationSummary`
  for EVERY day, including the current one — which is provisional by
  construction and never publishes authoritative slices. Current-day coverage
  could therefore never read complete, the coverage short-circuit never engaged,
  and the bootstrap, which only fires when coverage WOULD skip the core sync,
  was unreachable in production.

  V2 is NOT disabled here. The current day now uses the raw daily-coverage
  branch and V2's published-truth question is reserved for finalized days, so
  this seam exercises the production default.
*/
describe.skipIf(!SEAM)("the bootstrap lifecycle through syncMetaPartitionDay", () => {
  beforeAll(async () => {
    const sql = getDb();
    const [owner] = await sql<{ id: string }>`
      INSERT INTO users (name, email, password_hash)
      VALUES ('Orchestration seam', ${OWNER_EMAIL}, 'unused') RETURNING id
    `;
    const [business] = await sql<{ id: string }>`
      INSERT INTO businesses (name, owner_id)
      VALUES ('Orchestration seam', ${owner!.id}) RETURNING id
    `;
    businessId = business!.id;
    const [pa] = await sql<{ id: string }>`
      INSERT INTO provider_accounts (provider, external_account_id, account_name, timezone)
      VALUES ('meta', ${ACCOUNT}, 'Orchestration seam', 'America/Los_Angeles')
      RETURNING id
    `;
    accountRefId = pa!.id;
    await sql`
      INSERT INTO business_provider_accounts (
        business_id, provider, provider_account_ref_id, provider_account_id
      ) VALUES (${businessId}, 'meta', ${accountRefId}, ${ACCOUNT})
    `;
    /*
      A LEASED partition, held by this worker at this epoch. `syncMetaPartitionDay`
      writes checkpoints under the lease guard and rejects with
      `lease_conflict:checkpoint_write_rejected` otherwise — the orchestration
      never reaches the bootstrap decision without it.
    */
    const [partition] = await sql<{ id: string }>`
      INSERT INTO meta_sync_partitions (
        business_id, provider_account_id, lane, scope, partition_date, status,
        lease_owner, lease_expires_at, lease_epoch
      ) VALUES (
        ${businessId}, ${ACCOUNT}, 'core', 'core_warehouse', ${LA_TODAY}::date,
        'running', 'seam-worker', now() + interval '30 minutes', 1
      ) RETURNING id
    `;
    partitionId = partition!.id;
    /*
      The RUNNER lease the partition heartbeat requires. `heartbeatMetaPartitionLease`
      demands a live `sync_runner_leases` row for this business/worker in the
      meta provider scope; without it the heartbeat is rejected and the
      orchestration aborts before the bootstrap decision.
    */
    await sql`
      INSERT INTO sync_runner_leases (
        business_id, provider_scope, lease_owner, lease_expires_at
      ) VALUES (
        ${businessId}, 'meta', 'seam-worker', now() + interval '30 minutes'
      )
      ON CONFLICT DO NOTHING
    `;
    /*
      The growth fence refuses any sync without a fresh physical sample. Seeded
      with ample headroom because capacity is not what this seam is testing —
      `migration-safety-contract.db.test.ts` owns the refusal contract.
    */
    /*
      ── ROUND 20 ────────────────────────────────────────────────────────────
      Rerun-safety. The fence reads the LATEST healthcheck sample, so a sample
      left behind by an earlier run decides this one. Cleared first, the same
      way the capacity seam clears it.

      CONCURRENCY, stated rather than assumed: `system_capacity_snapshots` is
      global to the database, and `migration-safety-contract.db.test.ts`
      deliberately writes REFUSED samples into it to prove the fence. Two files
      writing one table cannot be made race-free from inside either of them, so
      they must not run concurrently against one cluster. The registered gate
      does not: `runChildVitest` in
      scripts/ephemeral-postgres-migrations-check.ts spawns ONE child process
      per test file and awaits it. Running both files in a single ad-hoc
      `vitest run` invocation will fail here, and that failure is the shared
      fixture, not the sync.
    */
    await sql.query(
      `DELETE FROM system_capacity_snapshots WHERE source = 'db_host_healthcheck'`,
    );
    /*
      And the database NAME is read from the connection rather than guessed.
      It used to be `process.env.PGDATABASE ?? "adsecute_r19"`: outside the
      seam runner PGDATABASE is unset, so the fixture claimed a sample about a
      database this process is not connected to and the fence -- correctly --
      refused the whole sync with `physical_database_identity_mismatch`. A
      fixture must not hardcode the name of the cluster one round happened to
      use.
    */
    const connectedDatabase = (
      (await sql.query(`SELECT current_database() AS name`)) as Array<{
        name: string;
      }>
    )[0]?.name;
    expect(typeof connectedDatabase).toBe("string");
    await sql.query(
      `INSERT INTO system_capacity_snapshots (source, payload, sampled_at)
       VALUES ($1, $2::jsonb, now())`,
      [
        "db_host_healthcheck",
        JSON.stringify({
          // The fence requires `payload.database.name` to equal the database
          // this process is connected to: a sample from another database is a
          // sample about another host's disk.
          database: { name: connectedDatabase },
          // The fence requires a complete disk measurement: total, used and
          // available, all non-negative integers.
          disks: [
            {
              path: "/var/lib/postgresql",
              totalBytes: 4 * 1024 * 1024 * 1024 * 1024,
              usedBytes: 2 * 1024 * 1024 * 1024 * 1024,
              availableBytes: 2 * 1024 * 1024 * 1024 * 1024,
            },
          ],
        }),
      ],
    );
    await seedCompleteCoverage();
    await seedLegacyReceipts();
  });

  it("first run forces ONE core refetch and links both config receipts", async () => {
    const calls = stubGraph();
    const runId = await newSyncRun();
    let orchestrationError: unknown = null;
    const result = await runPartitionDay(runId).catch((error) => {
      // A downstream stage may still fail on the stubbed payload; what this
      // case asserts is what happened UP TO and INCLUDING the core refetch.
      orchestrationError = error;
      return null;
    });
    expect(orchestrationError, String(orchestrationError)).toBeNull();

    /*
      THE PRECONDITION, READ FROM THE ORCHESTRATION ITSELF.

      The bootstrap only engages when coverage would otherwise SKIP the core
      sync. Asserting it here — from the value `syncMetaPartitionDay` actually
      computed, not from a separate query the test ran — is what stops this case
      passing for the wrong reason: a core refetch that happened because
      coverage was incomplete proves nothing about the bootstrap.
    */
    expect(
      (result as { beforeCoverage?: { productCoreComplete?: boolean } } | null)
        ?.beforeCoverage?.productCoreComplete,
      "coverage must be COMPLETE, or the refetch below is the ordinary path",
    ).toBe(true);

    /*
      THE DISCRIMINATOR, MADE REAL.

      First the premise: at the pinned instant the two zones are on DIFFERENT
      calendar days. Without this the assertion below is satisfied by either
      source and proves nothing -- which is exactly the state this file was in.
    */
    expect(
      ISTANBUL_TODAY,
      "the two zones must disagree, or the next assertion is vacuous",
    ).not.toBe(LA_TODAY);
    // Then the claim: the run used the DB BINDING (Los Angeles), and did not
    // use the credential profile (Istanbul).
    expect((result as { referenceToday?: string } | null)?.referenceToday).toBe(
      LA_TODAY,
    );
    expect(
      (result as { referenceToday?: string } | null)?.referenceToday,
    ).not.toBe(ISTANBUL_TODAY);
    expect((result as { truthState?: string } | null)?.truthState).toBe(
      "provisional",
    );
    // The attempt settles after its work, as the orchestrator settles it.
    await finishSyncRun(runId);

    // The bootstrap paid for exactly one attempt...
    expect(await ledgerRows()).toBe(1);
    // ...the core provider was actually reached...
    expect(calls.length).toBeGreaterThan(0);
    // ...and both config receipts are linked to THIS attempt.
    const linked = await linkedReceipts();
    /*
      The two endpoints the recent-edit authority reads. `ad_configs` is written
      by the same core sync and is linked too; it is not asserted as an exact
      set because this seam is about the authority's own endpoints, and pinning
      the full set would fail the next time an endpoint is added.
    */
    const endpoints = linked.map((row) => row.endpoint);
    expect(endpoints).toContain("campaign_configs");
    expect(endpoints).toContain("adset_configs");
    // Every linked receipt names THIS attempt, not the partition or the
    // observation run.
    expect(new Set(linked.map((row) => row.sync_run_id))).toEqual(new Set([runId]));

    /*
      ── ROUND 22, ITEM 1: THE BINDING SURVIVED ITS OWN SYNC ──────────────────

      This is the assertion the file could not make before. A real core sync had
      just run with a credential profile saying Europe/Istanbul, and ordinary
      warehouse persistence handed that value to the provider-account upsert,
      whose `COALESCE(EXCLUDED.timezone, existing)` moved the binding to match.
      One sync was enough to convert the "DB-bound" calendar into the credential
      payload -- and the previous revision of this file hid it by restoring the
      value by hand between the two runs.

      Nothing is restored now. The binding is read back exactly as the sync left
      it.
    */
    const sql = getDb();
    const [binding] = await sql<{ timezone: string | null }>`
      SELECT timezone FROM provider_accounts WHERE id = ${accountRefId}::uuid
    `;
    expect(
      binding?.timezone,
      "an ordinary core sync must not move the DB-bound account timezone",
    ).toBe("America/Los_Angeles");

    /*
      AND THE ROWS IT WROTE AGREE WITH IT. A binding that survives while every
      row it governs is stamped with the other calendar is only half a fix: the
      daily rows are what later readers resolve account-local days against.
    */
    const written = await sql<{ account_timezone: string }>`
      SELECT account_timezone FROM meta_account_daily
       WHERE business_id = ${businessId} AND provider_account_id = ${ACCOUNT}
    `;
    expect(written.length).toBeGreaterThan(0);
    for (const row of written) {
      expect(row.account_timezone).toBe("America/Los_Angeles");
    }
  });

  it("second same-day run short-circuits: no provider call, no new ledger row", async () => {
    /*
      ── ROUND 21, ITEM 1: WHY COVERAGE IS RE-SEEDED HERE ──────────────────────

      The first case forces a core refetch, and the Graph stub answers every
      endpoint with an EMPTY page. The refetch is therefore truthful about what
      it was told: it overwrites the account's daily row with zero spend and
      zero impressions, and coverage legitimately goes INCOMPLETE. A real
      provider returns the day's rows and coverage stays complete.

      So the empty account row is an artefact of the stub, not a fact about the
      orchestration, and leaving it in place would make this case assert a
      short-circuit in a state where a short-circuit must not happen. The rows
      are restored to what a real provider would have returned; the assertion
      that coverage IS complete is then read back from the orchestration itself
      rather than assumed.
    */
    await seedCompleteCoverage();
    /*
      THE DISCRIMINATING PRECONDITION, PROVEN AT THE MOMENT OF THE RUN: the
      binding and the credential profile really do disagree, and their two
      calendars really are different days at the pinned instant.
    */
    expect(
      (
        credentials() as unknown as {
          accountProfiles: Record<string, { timezone: string }>;
        }
      ).accountProfiles[ACCOUNT]!.timezone,
    ).toBe("Europe/Istanbul");
    expect(ISTANBUL_TODAY).not.toBe(LA_TODAY);
    const calls = stubGraph();
    const before = await ledgerRows();
    const runId = await newSyncRun();
    /*
      ── ROUND 21, ITEM 1 ──────────────────────────────────────────────────────
      NOT swallowed. This used to be `.catch(() => undefined)`, which meant the
      case could not tell "the coverage short-circuit resumed" from "the
      orchestration threw before it ever reached the provider" -- and the two
      assertions that followed were satisfied by both. A run that crashed on
      its first statement makes no Graph call and writes no ledger row either.
    */
    const result = await runPartitionDay(runId);

    /*
      The same precondition the first case reads, for the same reason: the
      short-circuit is only meaningful while coverage is COMPLETE. If coverage
      had gone incomplete between the two runs, "no provider call" would be a
      contradiction rather than a pass.
    */
    expect(
      (result as { beforeCoverage?: { productCoreComplete?: boolean } } | null)
        ?.beforeCoverage?.productCoreComplete,
      "coverage must still be COMPLETE for a short-circuit to be the finding",
    ).toBe(true);
    // Still the DB-bound calendar, at an instant where the two zones disagree.
    expect(ISTANBUL_TODAY).not.toBe(LA_TODAY);
    expect((result as { referenceToday?: string } | null)?.referenceToday).toBe(
      LA_TODAY,
    );

    // Still bound to Los Angeles, with nothing having restored it.
    const bindingSql = getDb();
    const [binding] = await bindingSql<{ timezone: string | null }>`
      SELECT timezone FROM provider_accounts WHERE id = ${accountRefId}::uuid
    `;
    expect(binding?.timezone).toBe("America/Los_Angeles");

    // The bootstrap budget was NOT spent again: the probe now finds both
    // config receipts linked to the attempt the first run paid for.
    expect(await ledgerRows()).toBe(before);
    /*
      ZERO Graph calls, not "no URL containing buying_type". The old filter
      passed while the run made any number of other provider requests, which is
      the opposite of what a short-circuit claims.
    */
    expect(calls, `unexpected Graph calls: ${calls.join(", ")}`).toHaveLength(0);
  });
});
