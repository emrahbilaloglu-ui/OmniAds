// Child of ephemeral-postgres-migrations-check. It runs only against the
// throwaway database URL force-set by the parent and never calls a provider.
//
// WHY THIS SEAM EXISTS
//
// `recordSlotOutcome` used to answer a whole-business rejection by failing
// every account the slot REQUIRES. Required and attempted are the same set
// only on a first, complete run. On a retry they are not: account A succeeded
// this morning, B and C did not, the next tick runs B and C alone, and if
// something SHARED then throws — the calibration pass at the top of
// `runMetaSnapshotForBusiness` is not wrapped in a catch — A's `success` row
// for the slot was overwritten as `failed`. The following tick then found A
// outstanding and regenerated it: a full generation, and a rewrite of truth
// that was already correct, caused by a failure that had nothing to do with A.
//
// The in-memory scheduler tests cannot close this. They double `getDb` with a
// tag function that answers SELECTs from a literal array, so the run record
// they assert on is the one the fixture typed rather than the one the upsert
// produced — and this defect lives exactly in the difference: a real
// `ON CONFLICT ... DO UPDATE SET status = EXCLUDED.status` on the real primary
// key is what silently replaces A's success. So this seam uses the migrated
// `meta_structure_snapshot_runs` and calls `runMetaSnapshotJobIfDue` — the
// production entry point the cron calls — four times in a row, changing only
// the world between ticks.
//
// Nothing about the rejection is faked either. The business throws because a
// single ad-level row carries `payload_json->>'add_to_cart' = 'n/a'`, and
// `readAggregatedAdsetMetricRows` casts that text to numeric with no guard
// (`lib/meta/calibration.ts:464`). That is one corrupt provider payload under
// ONE account's ad set taking the whole business's shared calibration down —
// the trigger this defect is about — and the repair between the third and
// fourth tick is that value becoming a number again.
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  metaSnapshotMissingPairsForSlot,
  runMetaSnapshotJobIfDue,
} from "@/lib/meta/scheduled";

const LABEL = "slot-retry-scope-seam";

function fail(label: string, detail?: string): never {
  throw new Error(`${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(label, `expected ${e}, got ${a}`);
}

const BUSINESS = "d0000000-0000-4000-8000-000000000701";
const OWNER = "d0000000-0000-4000-8000-0000000007ff";
const ACCOUNT_A = "act_7000000000001";
const ACCOUNT_B = "act_7000000000002";
const ACCOUNT_C = "act_7000000000003";

// One day, one slot. The morning window is the whole story here: the clock is
// held at 03:10 UTC so every tick is about slot 3 and the only thing that
// changes between them is the world.
const TICK = new Date("2026-05-08T03:10:00.000Z");
const SNAPSHOT_DATE = "2026-05-08";
const SLOT = 3;
const FACT_DATE = "2026-05-07";
const ADSET = "adset_7000000000002_1";

type RunRow = {
  provider_account_id: string;
  status: string;
  finished_at: string | null;
  source_max_date: string | null;
};

async function seedIdentity() {
  const sql = getDb();
  await sql.query(
    `INSERT INTO users (id, email, name, password_hash)
     VALUES ($1::uuid, 'slot-retry-scope-seam@example.test', 'Slot retry seam', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [OWNER],
  );
  // `is_demo_business` FALSE explicitly: `getActiveBusinesses` filters demo
  // workspaces out, and a demo business would make every tick a no-op.
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, timezone, currency, is_demo_business)
     VALUES ($1::uuid, 'Slot retry scope seam', $2::uuid, 'UTC', 'USD', FALSE)
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS, OWNER],
  );
  await sql.query(
    `INSERT INTO memberships (user_id, business_id, role, status)
     VALUES ($1::uuid, $2::uuid, 'admin', 'active')
     ON CONFLICT DO NOTHING`,
    [OWNER, BUSINESS],
  );
}

/**
 * Assign one Meta ad account to the business, the way the reader sees it.
 *
 * `readAssignmentRowsByBusiness` filters on `is_selected` and joins
 * `provider_accounts` for the external id, so both rows have to exist for an
 * account to count as required.
 */
async function assignAccount(externalAccountId: string, position: number) {
  const sql = getDb();
  const rows = (await sql.query(
    `INSERT INTO provider_accounts
       (provider, external_account_id, account_name, currency, timezone)
     VALUES ('meta', $1, 'Slot retry seam account', 'USD', 'UTC')
     ON CONFLICT (provider, external_account_id)
     DO UPDATE SET currency = EXCLUDED.currency
     RETURNING id::text AS id`,
    [externalAccountId],
  )) as Array<{ id: string }>;
  await sql.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id,
        position, is_selected)
     VALUES ($1, 'meta', $2::uuid, $3, $4, TRUE)
     ON CONFLICT (business_id, provider, provider_account_ref_id)
     DO UPDATE SET is_selected = TRUE`,
    [BUSINESS, rows[0]!.id, externalAccountId, position],
  );
}

/**
 * The corrupt provider payload that takes the shared calibration down.
 *
 * The ad-set row is what makes the aggregate query return anything at all; the
 * ad row underneath it carries the value that cannot be cast. Both belong to
 * account B, so the account whose slot must survive owns none of this data —
 * the failure reaching A is precisely what is being tested.
 */
async function writeAdSetWithAddToCart(addToCart: string) {
  const sql = getDb();
  await sql.query(
    `INSERT INTO meta_adset_daily
       (business_id, provider_account_id, date, campaign_id, adset_id,
        account_timezone, account_currency, spend, impressions, clicks, reach,
        conversions, revenue, roas, optimization_goal)
     VALUES ($1, $2, $3::date, 'camp_1', $4, 'UTC', 'USD',
             120, 4000, 80, 3000, 4, 300, 2.5, 'OFFSITE_CONVERSIONS')
     ON CONFLICT (business_id, provider_account_id, date, adset_id)
     DO NOTHING`,
    [BUSINESS, ACCOUNT_B, FACT_DATE, ADSET],
  );
  await sql.query(
    `INSERT INTO meta_ad_daily
       (business_id, provider_account_id, date, campaign_id, adset_id, ad_id,
        account_timezone, account_currency, spend, impressions, clicks, reach,
        conversions, revenue, roas, link_clicks, payload_json)
     VALUES ($1, $2, $3::date, 'camp_1', $4, 'ad_1', 'UTC', 'USD',
             120, 4000, 80, 3000, 4, 300, 2.5, 60,
             jsonb_build_object('add_to_cart', $5::text))
     ON CONFLICT (business_id, provider_account_id, date, ad_id)
     DO UPDATE SET payload_json = EXCLUDED.payload_json`,
    [BUSINESS, ACCOUNT_B, FACT_DATE, ADSET, addToCart],
  );
}

async function readRuns(): Promise<RunRow[]> {
  const sql = getDb();
  return (await sql.query(
    `SELECT provider_account_id, status,
            finished_at::text AS finished_at,
            source_max_date::text AS source_max_date
     FROM meta_structure_snapshot_runs
     WHERE business_id = $1 AND as_of_date = $2::date AND slot = $3
     ORDER BY provider_account_id`,
    [BUSINESS, SNAPSHOT_DATE, SLOT],
  )) as RunRow[];
}

function runFor(runs: RunRow[], account: string): RunRow {
  const row = runs.find((entry) => entry.provider_account_id === account);
  if (!row) fail("missing_run_row", `no slot ${SLOT} row for ${account}`);
  return row;
}

async function main() {
  await seedIdentity();

  /*
    TICK 1 — the business has one assigned account and it succeeds.

    This is how account A comes to hold a `success` row for the slot. It is
    written by the production path, not by this file.
  */
  await assignAccount(ACCOUNT_A, 0);
  const first = await runMetaSnapshotJobIfDue(TICK);
  if (first.skipped) fail("tick1_skipped", JSON.stringify(first));
  expectEqual(first.slot, SLOT, "tick1_slot");
  const afterFirst = await readRuns();
  expectEqual(afterFirst.length, 1, "tick1_run_rows");
  expectEqual(runFor(afterFirst, ACCOUNT_A).status, "success", "tick1_account_a");
  const aFinishedAt = runFor(afterFirst, ACCOUNT_A).finished_at;
  if (!aFinishedAt) fail("tick1_no_finished_at");

  /*
    The operator assigns two more ad accounts, and one of them brings a corrupt
    payload with it. The slot now REQUIRES three accounts and has ATTEMPTED
    one; the difference between those two sets is the whole finding.
  */
  await assignAccount(ACCOUNT_B, 1);
  await assignAccount(ACCOUNT_C, 2);
  await writeAdSetWithAddToCart("n/a");

  expectEqual(
    await metaSnapshotMissingPairsForSlot(SNAPSHOT_DATE, SLOT),
    [
      { businessId: BUSINESS, providerAccountId: ACCOUNT_B },
      { businessId: BUSINESS, providerAccountId: ACCOUNT_C },
    ],
    "retry_scope_excludes_the_successful_account",
  );

  /*
    TICK 2 — the retry of {B, C} throws as a whole business.

    Every account outcome is missing because the failure is upstream of the
    per-account loop, which is exactly the case that used to be answered with
    the required set.
  */
  const second = await runMetaSnapshotJobIfDue(TICK);
  if (second.skipped) fail("tick2_skipped", JSON.stringify(second));
  expectEqual(second.slot, SLOT, "tick2_slot");
  const rejected = second.result?.results ?? [];
  expectEqual(rejected.length, 1, "tick2_business_count");
  expectEqual(rejected[0]?.status, "rejected", "tick2_business_rejected");

  const afterSecond = await readRuns();
  expectEqual(afterSecond.length, 3, "tick2_run_rows");
  // The account that was never attempted keeps its success — and keeps the
  // very row it had, `finished_at` included, because nothing rewrote it.
  expectEqual(
    {
      status: runFor(afterSecond, ACCOUNT_A).status,
      finishedAt: runFor(afterSecond, ACCOUNT_A).finished_at,
    },
    { status: "success", finishedAt: aFinishedAt },
    "tick2_account_a_untouched",
  );
  expectEqual(runFor(afterSecond, ACCOUNT_B).status, "failed", "tick2_account_b");
  expectEqual(runFor(afterSecond, ACCOUNT_C).status, "failed", "tick2_account_c");

  // The next tick's own scope computation, from the persisted rows: A is not
  // in it, so the following tick regenerates nothing it already has.
  expectEqual(
    await metaSnapshotMissingPairsForSlot(SNAPSHOT_DATE, SLOT),
    [
      { businessId: BUSINESS, providerAccountId: ACCOUNT_B },
      { businessId: BUSINESS, providerAccountId: ACCOUNT_C },
    ],
    "after_rejection_scope_still_excludes_the_successful_account",
  );

  /*
    TICK 3 — the payload is repaired and the retry completes.

    A's row must STILL carry the timestamp it was written with at tick 1: not
    re-attempted, not re-recorded, not regenerated.
  */
  await writeAdSetWithAddToCart("7");
  const third = await runMetaSnapshotJobIfDue(TICK);
  if (third.skipped) fail("tick3_skipped", JSON.stringify(third));
  const thirdBusiness = third.result?.results?.[0];
  expectEqual(thirdBusiness?.status, "fulfilled", "tick3_business_fulfilled");
  expectEqual(
    thirdBusiness?.value?.succeededAccountIds,
    [ACCOUNT_B, ACCOUNT_C],
    "tick3_generated_only_the_outstanding_accounts",
  );

  const afterThird = await readRuns();
  expectEqual(
    afterThird.map((row) => [row.provider_account_id, row.status]),
    [
      [ACCOUNT_A, "success"],
      [ACCOUNT_B, "success"],
      [ACCOUNT_C, "success"],
    ],
    "tick3_all_three_succeeded",
  );
  expectEqual(
    runFor(afterThird, ACCOUNT_A).finished_at,
    aFinishedAt,
    "tick3_account_a_never_regenerated",
  );

  // TICK 4 — nothing is owed, so nothing runs.
  const fourth = await runMetaSnapshotJobIfDue(TICK);
  expectEqual(
    { skipped: fourth.skipped, reason: fourth.reason, slot: fourth.slot },
    { skipped: true, reason: "already_ran", slot: SLOT },
    "tick4_already_ran",
  );

  console.log(
    `[${LABEL}] PASS: a whole-business rejection of a {B, C} retry failed only `
    + "the two accounts that were attempted, left account A's slot row reading "
    + "success with its original finished_at, kept A out of the next missing-pair "
    + "computation, and the repaired retry closed the slot without regenerating A.",
  );
  resetDbClientCache();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  try {
    resetDbClientCache();
  } catch {
    // Best-effort cleanup after the original seam failure.
  }
  process.exit(1);
});
