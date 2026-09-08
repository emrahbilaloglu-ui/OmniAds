/**
 * The link-click repair and its readback verifier, against REAL PostgreSQL.
 *
 * WHY A DATABASE IS NOT OPTIONAL HERE. Every claim this file makes is about
 * rows a previous statement committed:
 *
 *   - "the dry run wrote nothing" is only meaningful if something could have
 *     been written, so it is checked by re-reading the table, not by counting
 *     the statements the command chose to issue;
 *   - the repair's candidate query does its ABSENT-versus-MEASURED-ZERO work in
 *     SQL — `jsonb_typeof(payload_json->'actions') = 'array'` and the
 *     `jsonb_array_elements` extraction — and a mocked client would answer that
 *     question with whatever the test author typed instead of with what jsonb
 *     actually holds;
 *   - the write is an `UPDATE ... FROM unnest(...)` whose pre-image guard is
 *     `IS NOT DISTINCT FROM`, which behaves differently from `=` exactly where
 *     it matters (NULL), and only PostgreSQL evaluates it;
 *   - the readback verifier's completeness verdict is an aggregate over the
 *     rows the repair left behind.
 *
 * The seeded rows are the four shapes production actually holds, measured
 * through the read-only tunnel on 2026-09-07 for the band pair ending
 * 2026-09-06: an absent column whose payload carries a `link_click` entry
 * (4,739 rows across the pair), an absent column whose actions array was
 * returned without that entry (1,710), an absent column with no actions array
 * at all (1,455), and a stored 0 the row's own payload disproves (1,692).
 *
 * Runs only inside an ephemeral-database seam (`ADSECUTE_EPHEMERAL_DB_SEAM=1`),
 * because outside one `DATABASE_URL` in this repository points at PRODUCTION
 * and this file writes rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getDb, getDbResolvedSettings, runDbTransaction } from "@/lib/db";

import {
  LINK_CLICK_REPAIR_BOUNDS,
  LINK_CLICK_REPAIR_UPDATE_SQL,
  runLinkClickRepair,
  type LinkClickRepairDb,
  type LinkClickRepairOptions,
} from "./link-click-repair-backfill";
import { runLinkClickReadbackVerify } from "./link-click-readback-verify";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

/** Ids chosen not to collide with any other stage of the seam gate. */
const BUSINESS_ID = "lcrepair-biz-9001";
const OTHER_BUSINESS_ID = "lcrepair-biz-9002";
const ACCOUNT_A = "act_lcrepair_9001";
const ACCOUNT_B = "act_lcrepair_9002";
const AS_OF = "2026-09-06";
/*
  The instant these historical captures were recorded at. Fixed rather than
  `now()` so the rows look like what they are — a capture the engine has
  already read — and so the repair's admissibility cutoff can sit after them.
*/
const SEEDED_ROW_CLOCK = "2026-09-06T06:00:00.000Z";
/** recent14 = 2026-08-24..2026-09-06, prior14 = 2026-08-10..2026-08-23. */

/*
  The production adapter shape: `getDb()` resolved PER CALL so it picks up the
  transaction-pinned client, and a `transaction` backed by `runDbTransaction`.
  Capturing the handle once — as this did — is exactly the defect: a pool hands
  out a different client per query, so a BEGIN and its UPDATEs can land on
  different connections and a mid-way failure leaves earlier batches applied.
*/
function db(overrides: Partial<LinkClickRepairDb> = {}): LinkClickRepairDb {
  const adapter: LinkClickRepairDb = {
    query: <TRow,>(text: string, values: unknown[]) =>
      getDb().query(text, values) as Promise<TRow[]>,
    transaction: <T,>(fn: (tx: LinkClickRepairDb) => Promise<T>) =>
      runDbTransaction(() => fn(adapter)),
    ...overrides,
  };
  return adapter;
}

function options(overrides: Partial<LinkClickRepairOptions> = {}): LinkClickRepairOptions {
  return {
    businessId: BUSINESS_ID,
    providerAccountIds: null,
    asOfDate: AS_OF,
    bandDays: 14,
    // The repair reads as of the same instant a decision for this day reads.
    admissibilityCutoff: "2026-09-06T23:59:59.999Z",
    maxRows: LINK_CLICK_REPAIR_BOUNDS.maxRowsDefault,
    pageSize: 3,
    maxAttempts: 1,
    execute: false,
    allowPartial: false,
    skipMeasuredZero: false,
    receiptOutPath: null,
    ...overrides,
  };
}

interface Seed {
  businessId?: string;
  account: string;
  date: string;
  adId: string;
  /** null = the column is absent. */
  linkClicks: number | null;
  /** null = payload_json carries no `actions` array at all. */
  actions: { action_type: string; value: string }[] | null;
}

/**
 * Every shape, in both bands, across two accounts, plus three rows that must
 * survive untouched: one outside the window, one on another business, and one
 * carrying a stored positive the payload disagrees with.
 */
const SEEDS: Seed[] = [
  // ad-A — a clean pair: absent on both sides, payload carries the count.
  { account: ACCOUNT_A, date: "2026-08-24", adId: "ad-A", linkClicks: null, actions: [{ action_type: "link_click", value: "10" }] },
  { account: ACCOUNT_A, date: "2026-08-11", adId: "ad-A", linkClicks: null, actions: [{ action_type: "link_click", value: "20" }] },
  // ad-B — the recent band is a MEASURED ZERO: the array came back without the entry.
  { account: ACCOUNT_A, date: "2026-08-25", adId: "ad-B", linkClicks: null, actions: [{ action_type: "landing_page_view", value: "3" }] },
  { account: ACCOUNT_A, date: "2026-08-12", adId: "ad-B", linkClicks: null, actions: [{ action_type: "link_click", value: "5" }] },
  // ad-C — the recent band has NO actions array: unmeasurable from storage.
  { account: ACCOUNT_A, date: "2026-08-26", adId: "ad-C", linkClicks: null, actions: null },
  { account: ACCOUNT_A, date: "2026-08-13", adId: "ad-C", linkClicks: null, actions: [{ action_type: "link_click", value: "7" }] },
  // ad-D — both sides store a fabricated 0 the row's own payload disproves.
  { account: ACCOUNT_A, date: "2026-08-27", adId: "ad-D", linkClicks: 0, actions: [{ action_type: "link_click", value: "9" }] },
  { account: ACCOUNT_A, date: "2026-08-14", adId: "ad-D", linkClicks: 0, actions: [{ action_type: "link_click", value: "3" }] },
  // ad-E — a second account, so "every scoped account" is a real claim.
  { account: ACCOUNT_B, date: "2026-08-28", adId: "ad-E", linkClicks: null, actions: [{ action_type: "link_click", value: "4" }] },
  { account: ACCOUNT_B, date: "2026-08-15", adId: "ad-E", linkClicks: null, actions: [{ action_type: "link_click", value: "6" }] },
  // ad-F — a stored 0 with nothing to corroborate it: named, never overwritten.
  { account: ACCOUNT_B, date: "2026-08-29", adId: "ad-F", linkClicks: 0, actions: null },
  { account: ACCOUNT_B, date: "2026-08-16", adId: "ad-F", linkClicks: null, actions: [{ action_type: "link_click", value: "2" }] },
  // ad-G — a stored measurement the payload contradicts. Never lowered.
  { account: ACCOUNT_B, date: "2026-08-30", adId: "ad-G", linkClicks: 50, actions: [{ action_type: "link_click", value: "77" }] },
  { account: ACCOUNT_B, date: "2026-08-17", adId: "ad-G", linkClicks: 50, actions: [{ action_type: "link_click", value: "77" }] },
  // Outside the band pair by one day — must not be repaired.
  { account: ACCOUNT_A, date: "2026-08-09", adId: "ad-OUT", linkClicks: null, actions: [{ action_type: "link_click", value: "99" }] },
  // A different business, inside the window — must not be repaired.
  { businessId: OTHER_BUSINESS_ID, account: ACCOUNT_A, date: "2026-08-24", adId: "ad-OTHER", linkClicks: null, actions: [{ action_type: "link_click", value: "88" }] },
];

async function seed(rows: readonly Seed[] = SEEDS) {
  const sql = getDb();
  for (const row of rows) {
    await sql.query(
      `INSERT INTO meta_ad_daily
         (business_id, provider_account_id, date, campaign_id, adset_id, ad_id,
          account_timezone, account_currency, spend, impressions, clicks, reach,
          conversions, revenue, roas, link_clicks, payload_json,
          truth_state, validation_status, created_at, updated_at)
       VALUES ($1, $2, $3::date, 'camp_lcrepair', 'adset_lcrepair', $4,
               'UTC', 'USD', 100, 5000, 120, 4000, 4, 400, 4.0, $5::bigint,
               CASE WHEN $6::jsonb IS NULL
                    THEN jsonb_build_object('ad_id', $4::text)
                    ELSE jsonb_build_object('ad_id', $4::text, 'actions', $6::jsonb)
               END,
               -- EXPLICIT, because the repair now applies the same
               -- admissibility contract decision hydration applies. Relying on
               -- column defaults left these rows provisional and clocked at
               -- wall-clock now, which is not what a historical capture the
               -- engine has already read looks like.
               'finalized', 'passed', $7::timestamptz, $7::timestamptz)
       ON CONFLICT (business_id, provider_account_id, date, ad_id) DO UPDATE SET
         link_clicks = EXCLUDED.link_clicks,
         payload_json = EXCLUDED.payload_json,
         truth_state = EXCLUDED.truth_state,
         validation_status = EXCLUDED.validation_status,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at`,
      [
        row.businessId ?? BUSINESS_ID,
        row.account,
        row.date,
        row.adId,
        row.linkClicks,
        row.actions === null ? null : JSON.stringify(row.actions),
        SEEDED_ROW_CLOCK,
      ],
    );
  }
}

async function storedLinkClicks(): Promise<Record<string, number | null>> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT business_id, provider_account_id, date::text AS date, ad_id,
            link_clicks::text AS link_clicks
       FROM meta_ad_daily
      WHERE business_id = ANY($1::text[])
      ORDER BY business_id, provider_account_id, date, ad_id`,
    [[BUSINESS_ID, OTHER_BUSINESS_ID]],
  )) as {
    business_id: string;
    provider_account_id: string;
    date: string;
    ad_id: string;
    link_clicks: string | null;
  }[];
  const output: Record<string, number | null> = {};
  for (const row of rows) {
    output[`${row.business_id}|${row.provider_account_id}|${row.date}|${row.ad_id}`] =
      row.link_clicks === null ? null : Number.parseInt(row.link_clicks, 10);
  }
  return output;
}

const key = (account: string, date: string, adId: string, business = BUSINESS_ID) =>
  `${business}|${account}|${date}|${adId}`;


/** The readback options these cases share. */
function verifyOptions(
  overrides: Partial<Parameters<typeof runLinkClickReadbackVerify>[0]["options"]> = {},
): Parameters<typeof runLinkClickReadbackVerify>[0]["options"] {
  return {
    businessId: BUSINESS_ID,
    providerAccountIds: null,
    asOfDate: AS_OF,
    bandDays: 14,
    receiptPath: null,
    requireComplete: false,
    // The readback counts the same population the repair repaired.
    admissibilityCutoff: "2026-09-06T23:59:59.999Z",
    minUsableBandPairs: 1,
    ...overrides,
  };
}

describe.runIf(SEAM)("link-click repair against real PostgreSQL", () => {
  beforeAll(async () => {
    await seed();
  });

  afterAll(async () => {
    const sql = getDb();
    await sql.query(`DELETE FROM meta_ad_daily WHERE business_id = ANY($1::text[])`, [
      [BUSINESS_ID, OTHER_BUSINESS_ID],
    ]);
  });

  it("plans the repair without writing a single row", async () => {
    const before = await storedLinkClicks();
    const result = await runLinkClickRepair({ db: db(), options: options() });
    const after = await storedLinkClicks();

    expect(result.mode).toBe("dry_run");
    expect(after).toEqual(before);
    expect(result.rowsWritten).toBe(0);
    // ad-A x2, ad-B prior, ad-B recent (measured zero), ad-C prior,
    // ad-D x2, ad-E x2, ad-F prior = 10 planned writes.
    expect(result.rowsPlanned).toBe(10);
    expect(result.actions.fill_measured_count).toBe(7);
    expect(result.actions.fill_measured_zero).toBe(1);
    expect(result.actions.correct_fabricated_zero).toBe(2);
    // ad-C recent has no actions array; ad-F recent stores an uncorroborated 0.
    expect(result.actions.unmeasurable_no_actions_payload).toBe(1);
    expect(result.actions.stored_zero_unprovable).toBe(1);
    expect(result.residualNeedingProviderResync).toBe(1);
    // ad-G is a stored positive: the candidate query never fetches it, so it is
    // not even classified.
    expect(result.candidatesExamined).toBe(12);
    // Both accounts, both bands.
    expect(result.accounts.map((account) => account.providerAccountId)).toEqual([
      ACCOUNT_A,
      ACCOUNT_B,
    ]);
    for (const account of result.accounts) {
      expect(account.bands.map((band) => band.band)).toEqual(["prior14", "recent14"]);
      for (const band of account.bands) {
        expect(band.rowsPlanned).toBeGreaterThan(0);
      }
    }
  });

  it("holds the measured-zero row when --skip-measured-zero is passed", async () => {
    const result = await runLinkClickRepair({
      db: db(),
      options: options({ skipMeasuredZero: true }),
    });
    expect(result.actions.fill_measured_zero).toBe(0);
    expect(result.rowsPlanned).toBe(9);
  });

  it("reports the band pair as unusable before the repair runs", async () => {
    const verdict = await runLinkClickReadbackVerify({
      db: db(),
      options: {
        businessId: BUSINESS_ID,
        providerAccountIds: null,
        asOfDate: AS_OF,
        bandDays: 14,
        receiptPath: null,
        requireComplete: false,
        admissibilityCutoff: "2026-09-06T23:59:59.999Z",
      // At least one ad must have a usable PAIR before the window counts as
      // complete: rows present is not the same as a decision being reachable.
      minUsableBandPairs: 1,
      },
    });
    expect(verdict.allBandsComplete).toBe(false);
    // ad-G alone: it is the only ad whose two bands already carry a stored
    // positive, and the repair never touches it. Every other ad is blocked.
    expect(verdict.totals.adsWithUsableBandPair).toBe(1);
    expect(verdict.totals.rowsStillAbsent).toBe(9);
    expect(verdict.totals.rowsFabricatedZeroRemaining).toBe(2);
    expect(verdict.totals.rowsSuspectUnprovableZero).toBe(1);
    const accountA = verdict.accounts.find(
      (account) => account.providerAccountId === ACCOUNT_A,
    )!;
    expect(accountA.bandPairCompleteEnoughFor14x14).toBe(false);
    const recent = accountA.bands.find((band) => band.band === "recent14")!;
    expect(recent.incompleteReasons).toContain("2_absent_rows_repairable_from_stored_payload");
    expect(recent.incompleteReasons).toContain("1_absent_rows_need_provider_resync");
    expect(recent.incompleteReasons).toContain("1_rows_still_store_a_fabricated_zero");
  });

  it("writes only the rows the stored payload authorizes", async () => {
    const result = await runLinkClickRepair({
      db: db(),
      options: options({ execute: true }),
    });
    expect(result.mode).toBe("execute");
    expect(result.rowsWritten).toBe(10);
    expect(result.rowsSkippedByPreImageDrift).toBe(0);

    const after = await storedLinkClicks();
    // Filled from the payload's own count.
    expect(after[key(ACCOUNT_A, "2026-08-24", "ad-A")]).toBe(10);
    expect(after[key(ACCOUNT_A, "2026-08-11", "ad-A")]).toBe(20);
    expect(after[key(ACCOUNT_B, "2026-08-28", "ad-E")]).toBe(4);
    expect(after[key(ACCOUNT_B, "2026-08-15", "ad-E")]).toBe(6);
    // Measured zero: the actions array came back without the entry.
    expect(after[key(ACCOUNT_A, "2026-08-25", "ad-B")]).toBe(0);
    // Fabricated zero corrected.
    expect(after[key(ACCOUNT_A, "2026-08-27", "ad-D")]).toBe(9);
    expect(after[key(ACCOUNT_A, "2026-08-14", "ad-D")]).toBe(3);
    // NEVER written: no actions array means nothing was measured.
    expect(after[key(ACCOUNT_A, "2026-08-26", "ad-C")]).toBeNull();
    // NEVER written: an uncorroborated stored 0 is named, not erased.
    expect(after[key(ACCOUNT_B, "2026-08-29", "ad-F")]).toBe(0);
    // NEVER lowered: a stored positive the payload contradicts is left alone.
    expect(after[key(ACCOUNT_B, "2026-08-30", "ad-G")]).toBe(50);
    expect(after[key(ACCOUNT_B, "2026-08-17", "ad-G")]).toBe(50);
    // Out of scope by one day, and out of scope by business.
    expect(after[key(ACCOUNT_A, "2026-08-09", "ad-OUT")]).toBeNull();
    expect(after[key(ACCOUNT_A, "2026-08-24", "ad-OTHER", OTHER_BUSINESS_ID)]).toBeNull();
  });

  it("is idempotent: a second execute finds nothing left to write", async () => {
    const result = await runLinkClickRepair({
      db: db(),
      options: options({ execute: true }),
    });
    expect(result.rowsPlanned).toBe(0);
    expect(result.rowsWritten).toBe(0);
    // The two remaining candidates are the rows the repair must never touch.
    expect(result.actions.unmeasurable_no_actions_payload).toBe(1);
    expect(result.actions.stored_zero_unprovable).toBe(1);
  });

  it("reads back per account and per band, and names what still blocks the pair", async () => {
    const verdict = await runLinkClickReadbackVerify({
      db: db(),
      options: {
        businessId: BUSINESS_ID,
        providerAccountIds: null,
        asOfDate: AS_OF,
        bandDays: 14,
        receiptPath: null,
        requireComplete: false,
        admissibilityCutoff: "2026-09-06T23:59:59.999Z",
      // At least one ad must have a usable PAIR before the window counts as
      // complete: rows present is not the same as a decision being reachable.
      minUsableBandPairs: 1,
      },
    });

    const accountA = verdict.accounts.find(
      (account) => account.providerAccountId === ACCOUNT_A,
    )!;
    const priorA = accountA.bands.find((band) => band.band === "prior14")!;
    const recentA = accountA.bands.find((band) => band.band === "recent14")!;

    // The prior band is now whole: four rows, four measurements.
    expect(priorA.rowsExpected).toBe(4);
    expect(priorA.rowsPresent).toBe(4);
    expect(priorA.rowsStillAbsent).toBe(0);
    expect(priorA.linkClicksTotal).toBe(20 + 5 + 7 + 3);
    expect(priorA.bandComplete).toBe(true);

    // The recent band is not, and the reason is named rather than summarised:
    // one row holds no measurement anywhere in the database.
    expect(recentA.rowsExpected).toBe(4);
    expect(recentA.rowsStillAbsent).toBe(1);
    expect(recentA.rowsUnmeasurableFromStorage).toBe(1);
    expect(recentA.bandComplete).toBe(false);
    expect(recentA.incompleteReasons).toEqual(["1_absent_rows_need_provider_resync"]);
    expect(accountA.bandPairCompleteEnoughFor14x14).toBe(false);

    // ad-A and ad-D have a positive total on both sides; ad-B's recent band is a
    // genuine zero and ad-C's recent band is still absent.
    expect(accountA.adsInBothBands).toBe(4);
    expect(accountA.adsWithUsableBandPair).toBe(2);
    expect(accountA.adsBlockedByAbsence).toBe(1);
    expect(accountA.adsBlockedByZeroTotal).toBe(1);

    const accountB = verdict.accounts.find(
      (account) => account.providerAccountId === ACCOUNT_B,
    )!;
    const recentB = accountB.bands.find((band) => band.band === "recent14")!;
    expect(recentB.rowsSuspectUnprovableZero).toBe(1);
    expect(recentB.incompleteReasons).toEqual(["1_rows_store_an_uncorroborated_zero"]);
    expect(verdict.allBandsComplete).toBe(false);
  });

  it("compares the repair's receipt against what the table actually holds", async () => {
    const receipt = await runLinkClickRepair({
      db: db(),
      options: options({ execute: true }),
    });
    const verdict = await runLinkClickReadbackVerify({
      db: db(),
      options: verifyOptions({ receiptPath: "receipt.json" }),
      receipt,
    });
    for (const account of verdict.accounts) {
      for (const band of account.bands) {
        expect(band.rowsWrittenByRepair).toBe(0);
        expect(band.rowsPlannedByRepair).toBe(0);
      }
    }
    expect(verdict.totals.rowsWrittenByRepair).toBe(0);
  });

  it("refuses a receipt from a different window", async () => {
    const receipt = await runLinkClickRepair({ db: db(), options: options() });
    await expect(
      runLinkClickReadbackVerify({
        db: db(),
        options: verifyOptions({
          asOfDate: "2026-08-30",
          admissibilityCutoff: "2026-08-30T23:59:59.999Z",
          receiptPath: "receipt.json",
        }),
        receipt,
      }),
    ).rejects.toThrow(/receipt_scope_mismatch/);
  });

  it("refuses a receipt taken at a different as-of instant", async () => {
    /*
      SAME DATES, DIFFERENT POPULATION. The window matched, so this receipt
      used to be accepted and its planned/written counts printed beside a
      readback of rows it never examined. The cutoff is part of the scope.
    */
    const receipt = await runLinkClickRepair({ db: db(), options: options() });
    await expect(
      runLinkClickReadbackVerify({
        db: db(),
        options: verifyOptions({
          admissibilityCutoff: "2026-09-05T23:59:59.999Z",
          receiptPath: "receipt.json",
        }),
        receipt,
      }),
    ).rejects.toThrow(/receipt_scope_mismatch/);
  });

  it("skips rather than clobbers a row whose pre-image moved under it", async () => {
    // The concurrency case, driven through the shipped statement: the repair
    // planned against a NULL, the authoritative writer stored 33 in between,
    // and the guard must decline the write instead of overwriting it.
    const sql = getDb();
    const updated = (await sql.query(LINK_CLICK_REPAIR_UPDATE_SQL, [
      BUSINESS_ID,
      [ACCOUNT_A],
      ["2026-08-24"],
      ["ad-A"],
      [999],
      [null],
    ])) as { ad_id: string }[];
    expect(updated).toHaveLength(0);
    const after = await storedLinkClicks();
    expect(after[key(ACCOUNT_A, "2026-08-24", "ad-A")]).toBe(10);

    // The same statement with the CORRECT pre-image does write, which proves
    // the empty result above came from the guard and not from a broken query.
    const applied = (await sql.query(LINK_CLICK_REPAIR_UPDATE_SQL, [
      BUSINESS_ID,
      [ACCOUNT_A],
      ["2026-08-24"],
      ["ad-A"],
      [999],
      [10],
    ])) as { ad_id: string }[];
    expect(applied).toHaveLength(1);
    const restored = await storedLinkClicks();
    expect(restored[key(ACCOUNT_A, "2026-08-24", "ad-A")]).toBe(999);
  });

  it("narrows to the accounts it was given", async () => {
    const result = await runLinkClickRepair({
      db: db(),
      options: options({ providerAccountIds: [ACCOUNT_B] }),
    });
    expect(result.accounts.map((account) => account.providerAccountId)).toEqual([ACCOUNT_B]);
    expect(
      result.accounts.every((account) =>
        account.bands.every((band) => band.rowsPlanned === 0),
      ),
    ).toBe(true);
  });
});

/*
  CODEX B11/B12/B13 — plan-then-execute, source freshness, and admissibility,
  proven against the real database.
*/
describe.runIf(SEAM)("link-click repair: plan, freshness and admissibility", () => {
  /*
    Re-seeded per case, not once: the freshness case EXECUTES a real repair, so
    a later case sharing that state would find no remaining candidates and
    assert against an empty population. `seed()` upserts, so this restores the
    fixture rather than accumulating it.
  */
  beforeEach(async () => {
    await seed();
  });

  afterAll(async () => {
    const sql = getDb();
    await sql.query(`DELETE FROM meta_ad_daily WHERE business_id = ANY($1::text[])`, [
      [BUSINESS_ID, OTHER_BUSINESS_ID],
    ]);
  });

  /*
    B11. Writes used to happen page by page INSIDE the scan, so a run that hit
    `--max-rows` had already repaired every earlier page before the truncation
    refusal fired — the guard arrived after the damage. A truncated execute must
    now change nothing at all.
  */
  it("changes zero rows when --max-rows truncates the plan", async () => {
    const before = await storedLinkClicks();
    // Small enough to stop mid-window, and a page size small enough that the
    // old design would certainly have committed at least one page first.
    await expect(
      runLinkClickRepair({
        db: db(),
        options: options({
          execute: true,
          maxRows: 3,
          pageSize: 1,
          allowPartial: false,
        }),
      }),
    ).rejects.toThrow(/truncated/i);
    const after = await storedLinkClicks();
    expect(after).toEqual(before);
  });

  /*
    B12. Decision hydration admits an ad-day only when BOTH row clocks are at or
    before the cutoff, so restamping `updated_at` on repair made the repaired
    row invisible at every earlier point in time: repairing history erased it.
  */
  it("leaves the source freshness clock untouched", async () => {
    const sql = getDb();
    const clockOf = async () =>
      (
        (await sql.query(
          `SELECT ad_id, updated_at::text AS updated_at
             FROM meta_ad_daily WHERE business_id = $1 ORDER BY ad_id, date`,
          [BUSINESS_ID],
        )) as Array<{ ad_id: string; updated_at: string }>
      ).map((row) => `${row.ad_id}:${row.updated_at}`);

    const before = await clockOf();
    const result = await runLinkClickRepair({
      db: db(),
      options: options({ execute: true }),
    });
    expect(result.rowsWritten).toBeGreaterThan(0);
    const after = await clockOf();
    expect(after).toEqual(before);
  });

  /*
    B13. The scan applies the SAME admissibility contract decision hydration
    applies. A provisional capture, a failed validation and a row recorded after
    the cutoff are all rows the engine will never read, so repairing them is at
    best wasted work and at worst an edit to a capture still being reconciled.
  */
  it("excludes provisional, failed-validation and post-cutoff rows", async () => {
    const sql = getDb();
    const admissible = await runLinkClickRepair({
      db: db(),
      options: options(),
    });
    expect(admissible.candidatesExamined).toBeGreaterThan(0);

    for (const [column, value] of [
      ["truth_state", "provisional"],
      ["validation_status", "failed"],
    ] as const) {
      await sql.query(
        `UPDATE meta_ad_daily SET ${column} = $2 WHERE business_id = $1`,
        [BUSINESS_ID, value],
      );
      const excluded = await runLinkClickRepair({ db: db(), options: options() });
      expect(excluded.candidatesExamined, column).toBe(0);
      expect(excluded.rowsPlanned, column).toBe(0);
      await sql.query(
        `UPDATE meta_ad_daily SET truth_state = 'finalized', validation_status = 'passed'
          WHERE business_id = $1`,
        [BUSINESS_ID],
      );
    }

    // Post-cutoff: the rows exist but were recorded after the instant the
    // repair reads as of, so they are outside the population it may touch.
    const postCutoff = await runLinkClickRepair({
      db: db(),
      options: options({ admissibilityCutoff: "2000-01-01T00:00:00.000Z" }),
    });
    expect(postCutoff.candidatesExamined).toBe(0);
    expect(postCutoff.rowsPlanned).toBe(0);

    // The control: with the real cutoff the same rows are admitted again.
    const restored = await runLinkClickRepair({ db: db(), options: options() });
    expect(restored.candidatesExamined).toBe(admissible.candidatesExamined);
  });
});

/*
  CODEX B14 — projection completeness is not decision reachability.

  `bandPairCompleteEnoughFor14x14` asked only whether the ROWS were present and
  measurable. An account can satisfy that entirely and still have no ad whose
  two bands both carry a positive link-click total, which is what
  `admitCompositeBand` requires. Reported as "complete", that tells a release
  gate the repair worked while no decision can use it.
*/
describe.runIf(SEAM)("readback completeness requires a reachable decision", () => {
  beforeEach(async () => {
    await seed();
  });

  afterAll(async () => {
    const sql = getDb();
    await sql.query(`DELETE FROM meta_ad_daily WHERE business_id = ANY($1::text[])`, [
      [BUSINESS_ID, OTHER_BUSINESS_ID],
    ]);
  });

  it("refuses an all-zero window whose rows are entirely present", async () => {
    const sql = getDb();
    // Every row measured, every measurement zero: complete as a projection,
    // unusable as evidence.
    await sql.query(
      `UPDATE meta_ad_daily SET link_clicks = 0,
         payload_json = jsonb_build_object('ad_id', ad_id, 'actions',
           jsonb_build_array(jsonb_build_object('action_type', 'link_click', 'value', '0')))
       WHERE business_id = $1`,
      [BUSINESS_ID],
    );
    const result = await runLinkClickReadbackVerify({
      db: db(),
      options: verifyOptions(),
      receipt: null,
    });
    expect(result.totals.adsWithUsableBandPair).toBe(0);
    expect(result.allBandsComplete).toBe(false);
  });

  it("refuses a window whose usable bands are DISJOINT per ad", async () => {
    const sql = getDb();
    /*
      The subtler shape: both bands are fully measured and positive in
      aggregate, but no single ad is positive in BOTH. Every per-band summary
      looks healthy; the 14/14 pair is still unreachable for every ad.
    */
    await sql.query(
      /*
        The RECENT band starts 13 days before the as-of day; an earlier draft
        compared against the as-of day itself, which is the band's last day, so
        almost every row fell on the same side and the bands were not disjoint
        at all. Each ad is now positive in exactly one band and zero in the
        other, decided by the last character of its id.
      */
      `UPDATE meta_ad_daily SET link_clicks = CASE
         WHEN (date >= ($2::date - 13)) = (ad_id ~ '[02468]$') THEN 5 ELSE 0 END,
         payload_json = jsonb_build_object('ad_id', ad_id, 'actions',
           jsonb_build_array(jsonb_build_object('action_type', 'link_click', 'value',
             (CASE WHEN (date >= ($2::date - 13)) = (ad_id ~ '[02468]$') THEN 5 ELSE 0 END)::text)))
       WHERE business_id = $1`,
      [BUSINESS_ID, AS_OF],
    );
    const result = await runLinkClickReadbackVerify({
      db: db(),
      options: verifyOptions(),
      receipt: null,
    });
    expect(result.totals.adsWithUsableBandPair).toBe(0);
    expect(result.allBandsComplete).toBe(false);
  });

  it("accepts a window where at least one ad has a usable PAIR", async () => {
    const sql = getDb();
    // The control, without which the two refusals above would be satisfied by
    // a gate that refuses everything.
    await sql.query(
      `UPDATE meta_ad_daily SET link_clicks = 7,
         payload_json = jsonb_build_object('ad_id', ad_id, 'actions',
           jsonb_build_array(jsonb_build_object('action_type', 'link_click', 'value', '7')))
       WHERE business_id = $1`,
      [BUSINESS_ID],
    );
    const result = await runLinkClickReadbackVerify({
      db: db(),
      options: verifyOptions(),
      receipt: null,
    });
    expect(result.totals.adsWithUsableBandPair).toBeGreaterThan(0);
    expect(result.allBandsComplete).toBe(true);
  });
});


/*
  ── THE TRANSACTION BOUNDARY IS THE CLAIM ───────────────────────────────────
  The executor used to issue `BEGIN`, the batch `UPDATE`s and `COMMIT` as
  separate `getDb().query` calls. A pool hands out a DIFFERENT client per call,
  so with more than one connection available the `BEGIN` opened on one
  connection while the updates ran, in autocommit, on others: a failure in a
  later batch left every earlier batch permanently applied.

  These two cases are written so that shape FAILS them. The pool is asserted to
  have more than one connection, a second connection is leased for the whole
  run, and the observation that discriminates is taken from that second
  connection MID-RUN: after two batches have been applied, an outside reader
  must still see nothing. Under the old code it would see the first two
  batches. Then the injected failure must leave zero persisted change — the
  first batch included — and the control must commit all six rows.
*/
const TX_BUSINESS_ID = "lcrepair-biz-9003";
const TX_ACCOUNT = "act_lcrepair_9003";

/** Three ads x two bands = six repairable rows; at pageSize 2 that is three batches. */
const TX_SEEDS: Seed[] = [
  { businessId: TX_BUSINESS_ID, account: TX_ACCOUNT, date: "2026-08-24", adId: "ad-TX1", linkClicks: null, actions: [{ action_type: "link_click", value: "11" }] },
  { businessId: TX_BUSINESS_ID, account: TX_ACCOUNT, date: "2026-08-25", adId: "ad-TX2", linkClicks: null, actions: [{ action_type: "link_click", value: "12" }] },
  { businessId: TX_BUSINESS_ID, account: TX_ACCOUNT, date: "2026-08-26", adId: "ad-TX3", linkClicks: null, actions: [{ action_type: "link_click", value: "13" }] },
  { businessId: TX_BUSINESS_ID, account: TX_ACCOUNT, date: "2026-08-11", adId: "ad-TX1", linkClicks: null, actions: [{ action_type: "link_click", value: "14" }] },
  { businessId: TX_BUSINESS_ID, account: TX_ACCOUNT, date: "2026-08-12", adId: "ad-TX2", linkClicks: null, actions: [{ action_type: "link_click", value: "15" }] },
  { businessId: TX_BUSINESS_ID, account: TX_ACCOUNT, date: "2026-08-13", adId: "ad-TX3", linkClicks: null, actions: [{ action_type: "link_click", value: "16" }] },
];

function txOptions(overrides: Partial<LinkClickRepairOptions> = {}): LinkClickRepairOptions {
  return options({
    businessId: TX_BUSINESS_ID,
    // Two rows per batch, six planned rows: the third batch is the one that fails.
    pageSize: 2,
    ...overrides,
  });
}

/**
 * Reads the six rows through the handle it is GIVEN.
 *
 * Passing the pool-bound wrapper resolved before the repair opened its
 * transaction is what makes the mid-run read an outside read: that object
 * holds the pool, not the transaction's pinned client, so it cannot see
 * uncommitted work no matter what `AsyncLocalStorage` says.
 */
async function txStoredLinkClicks(
  handle: { query: (text: string, values: unknown[]) => Promise<unknown> },
): Promise<(number | null)[]> {
  const rows = (await handle.query(
    `SELECT link_clicks::text AS link_clicks
       FROM meta_ad_daily
      WHERE business_id = $1
      ORDER BY date, ad_id`,
    [TX_BUSINESS_ID],
  )) as { link_clicks: string | null }[];
  return rows.map((row) =>
    row.link_clicks === null ? null : Number.parseInt(row.link_clicks, 10),
  );
}

describe.runIf(SEAM)("link-click repair writes inside ONE pinned transaction", () => {
  beforeEach(async () => {
    const sql = getDb();
    await sql.query(`DELETE FROM meta_ad_daily WHERE business_id = $1`, [TX_BUSINESS_ID]);
    await seed(TX_SEEDS);
  });

  afterAll(async () => {
    const sql = getDb();
    await sql.query(`DELETE FROM meta_ad_daily WHERE business_id = $1`, [TX_BUSINESS_ID]);
  });

  it("rolls back the FIRST batch too when a later batch fails", async () => {
    // More than one connection: with a pool of one, an unpinned BEGIN would
    // land on the same client by accident and this case would prove nothing.
    expect(getDbResolvedSettings().poolMax).toBeGreaterThan(1);

    /*
      Resolved BEFORE the repair opens its transaction, so it is the pool-bound
      wrapper and every query on it takes its own connection. Held for the
      whole run: that is the concurrent lease.
    */
    const outsideConnection = getDb();
    expect(await txStoredLinkClicks(outsideConnection)).toEqual([
      null, null, null, null, null, null,
    ]);

    let updateCalls = 0;
    let seenFromOutsideAfterTwoBatches: (number | null)[] | null = null;

    const adapter = db({
      query: (async <TRow,>(text: string, values: unknown[]) => {
        if (text !== LINK_CLICK_REPAIR_UPDATE_SQL) {
          return (await getDb().query(text, values)) as TRow[];
        }
        updateCalls += 1;
        if (updateCalls === 3) {
          throw new Error("injected_failure_in_third_batch");
        }
        const rows = (await getDb().query(text, values)) as TRow[];
        if (updateCalls === 2) {
          // Two batches applied. An outside reader must see NONE of them.
          seenFromOutsideAfterTwoBatches = await txStoredLinkClicks(outsideConnection);
        }
        return rows;
      }) as LinkClickRepairDb["query"],
    });

    await expect(
      runLinkClickRepair({ db: adapter, options: txOptions({ execute: true }) }),
    ).rejects.toThrow("injected_failure_in_third_batch");

    // The failure really was in the third batch, after two had been applied.
    expect(updateCalls).toBe(3);
    expect(seenFromOutsideAfterTwoBatches).toEqual([null, null, null, null, null, null]);
    // And after the rollback nothing persisted anywhere: batch one included.
    expect(await txStoredLinkClicks(getDb())).toEqual([null, null, null, null, null, null]);
  });

  it("commits every batch when nothing fails", async () => {
    // The control, without which the rollback above would be satisfied by a
    // repair that never writes at all.
    const result = await runLinkClickRepair({
      db: db(),
      options: txOptions({ execute: true }),
    });
    expect(result.rowsPlanned).toBe(6);
    expect(result.rowsWritten).toBe(6);
    // Ordered by date, ad_id: the four prior-band rows sort first.
    expect(await txStoredLinkClicks(getDb())).toEqual([14, 15, 16, 11, 12, 13]);
  });

  it("refuses to write at all through a handle with no transaction boundary", async () => {
    // The pool-handle-only adapter the executor used to accept.
    const poolOnly: LinkClickRepairDb = {
      query: <TRow,>(text: string, values: unknown[]) =>
        getDb().query(text, values) as Promise<TRow[]>,
    };
    await expect(
      runLinkClickRepair({ db: poolOnly, options: txOptions({ execute: true }) }),
    ).rejects.toThrow("link_click_repair_no_transaction_boundary");
    expect(await txStoredLinkClicks(getDb())).toEqual([null, null, null, null, null, null]);
  });
});


/*
  ── THE READBACK COUNTS THE POPULATION THE ENGINE READS ─────────────────────
  The verifier counted every row in the window. A band could therefore be
  called incomplete because of a provisional capture, a row whose validation
  failed, or a row recorded after the cutoff — none of which decision
  hydration will ever admit — and, the other way round, could count such rows
  as present. Each case below adds ONE inadmissible absent row to an otherwise
  complete account: if it were counted, the account would go incomplete. The
  control adds the same row as ADMISSIBLE and requires exactly that.
*/
const ADM_BUSINESS_ID = "lcrepair-biz-9004";
const ADM_ACCOUNT_A = "act_lcrepair_9004a";
const ADM_ACCOUNT_B = "act_lcrepair_9004b";
const ADM_CUTOFF = "2026-09-06T23:59:59.999Z";

async function insertAdmissibilityRow(row: {
  account: string;
  date: string;
  adId: string;
  linkClicks: number | null;
  truthState?: string;
  validationStatus?: string;
  createdAt?: string;
  updatedAt?: string;
}) {
  const sql = getDb();
  await sql.query(
    `INSERT INTO meta_ad_daily
       (business_id, provider_account_id, date, campaign_id, adset_id, ad_id,
        account_timezone, account_currency, spend, impressions, clicks, reach,
        conversions, revenue, roas, link_clicks, payload_json,
        truth_state, validation_status, created_at, updated_at)
     VALUES ($1, $2, $3::date, 'camp_lcadm', 'adset_lcadm', $4,
             'UTC', 'USD', 100, 5000, 120, 4000, 4, 400, 4.0, $5::bigint,
             jsonb_build_object('ad_id', $4::text, 'actions',
               jsonb_build_array(jsonb_build_object('action_type', 'link_click', 'value', '9'))),
             $6, $7, $8::timestamptz, $9::timestamptz)
     ON CONFLICT (business_id, provider_account_id, date, ad_id) DO UPDATE SET
       link_clicks = EXCLUDED.link_clicks,
       truth_state = EXCLUDED.truth_state,
       validation_status = EXCLUDED.validation_status,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at`,
    [
      ADM_BUSINESS_ID,
      row.account,
      row.date,
      row.adId,
      row.linkClicks,
      row.truthState ?? "finalized",
      row.validationStatus ?? "passed",
      row.createdAt ?? SEEDED_ROW_CLOCK,
      row.updatedAt ?? SEEDED_ROW_CLOCK,
    ],
  );
}

function admOptions(
  overrides: Partial<Parameters<typeof runLinkClickReadbackVerify>[0]["options"]> = {},
) {
  return verifyOptions({
    businessId: ADM_BUSINESS_ID,
    admissibilityCutoff: ADM_CUTOFF,
    ...overrides,
  });
}

describe.runIf(SEAM)("link-click readback applies hydration's admissibility contract", () => {
  beforeEach(async () => {
    const sql = getDb();
    await sql.query(`DELETE FROM meta_ad_daily WHERE business_id = $1`, [ADM_BUSINESS_ID]);
    // One ad with a usable, admissible, positive band PAIR: the account is
    // complete until an inadmissible row is allowed to break it.
    await insertAdmissibilityRow({
      account: ADM_ACCOUNT_A, date: "2026-08-25", adId: "ad-ADM", linkClicks: 5,
    });
    await insertAdmissibilityRow({
      account: ADM_ACCOUNT_A, date: "2026-08-12", adId: "ad-ADM", linkClicks: 7,
    });
  });

  afterAll(async () => {
    const sql = getDb();
    await sql.query(`DELETE FROM meta_ad_daily WHERE business_id = $1`, [ADM_BUSINESS_ID]);
  });

  it("counts the admissible baseline as complete", async () => {
    const verdict = await runLinkClickReadbackVerify({ db: db(), options: admOptions() });
    expect(verdict.allBandsComplete).toBe(true);
    expect(verdict.totals.adsWithUsableBandPair).toBe(1);
    expect(verdict.totals.rowsExpected).toBe(2);
  });

  const inadmissible = [
    ["a provisional capture", { truthState: "provisional" }],
    ["a failed validation", { validationStatus: "failed" }],
    ["a row created after the cutoff", { createdAt: "2026-09-07T00:00:01.000Z" }],
    ["a row last updated after the cutoff", { updatedAt: "2026-09-07T00:00:01.000Z" }],
  ] as const;

  it.each(inadmissible.map(([name, attrs]) => [name, attrs] as const))(
    "excludes %s",
    async (_name, attrs) => {
      await insertAdmissibilityRow({
        account: ADM_ACCOUNT_A,
        date: "2026-08-26",
        adId: "ad-INADMISSIBLE",
        linkClicks: null,
        ...attrs,
      });
      const verdict = await runLinkClickReadbackVerify({ db: db(), options: admOptions() });
      // The row exists in the window. It is simply not part of the population
      // any decision for this day will read, so it does not appear here.
      expect(verdict.totals.rowsExpected).toBe(2);
      expect(verdict.totals.rowsStillAbsent).toBe(0);
      expect(verdict.allBandsComplete).toBe(true);
    },
  );

  it("counts the SAME row when it is admissible, which is what makes the four exclusions discriminating", async () => {
    await insertAdmissibilityRow({
      account: ADM_ACCOUNT_A,
      date: "2026-08-26",
      adId: "ad-INADMISSIBLE",
      linkClicks: null,
    });
    const verdict = await runLinkClickReadbackVerify({ db: db(), options: admOptions() });
    expect(verdict.totals.rowsExpected).toBe(3);
    expect(verdict.totals.rowsStillAbsent).toBe(1);
    expect(verdict.allBandsComplete).toBe(false);
    const recent = verdict.accounts[0]!.bands.find((band) => band.band === "recent14")!;
    expect(recent.incompleteReasons).toContain("1_absent_rows_repairable_from_stored_payload");
  });

  it("keeps an explicitly requested account that answered with nothing", async () => {
    /*
      A AND B WERE ASKED ABOUT; ONLY A HAS ROWS. B used to drop out of the
      report entirely, so `allBandsComplete` answered a narrower question than
      the one it was asked and read as a green light for both accounts.
    */
    const verdict = await runLinkClickReadbackVerify({
      db: db(),
      options: admOptions({ providerAccountIds: [ADM_ACCOUNT_A, ADM_ACCOUNT_B] }),
    });
    expect(verdict.accounts.map((account) => account.providerAccountId)).toEqual([
      ADM_ACCOUNT_A,
      ADM_ACCOUNT_B,
    ]);
    const b = verdict.accounts.find(
      (account) => account.providerAccountId === ADM_ACCOUNT_B,
    )!;
    expect(b.adsInWindow).toBe(0);
    expect(b.bandPairCompleteEnoughFor14x14).toBe(false);
    for (const band of b.bands) {
      expect(band.rowsExpected).toBe(0);
      expect(band.incompleteReasons).toEqual(["band_has_no_rows_in_scope"]);
    }
    expect(verdict.allBandsComplete).toBe(false);
  });

  it("keeps a requested account whose only rows are inadmissible", async () => {
    // The sharper form: B HAS rows, and every one of them is refused. The
    // account is still reported, still incomplete — not silently dropped.
    await insertAdmissibilityRow({
      account: ADM_ACCOUNT_B, date: "2026-08-25", adId: "ad-B1", linkClicks: 5,
      truthState: "provisional",
    });
    await insertAdmissibilityRow({
      account: ADM_ACCOUNT_B, date: "2026-08-12", adId: "ad-B1", linkClicks: 7,
      validationStatus: "failed",
    });
    const verdict = await runLinkClickReadbackVerify({
      db: db(),
      options: admOptions({ providerAccountIds: [ADM_ACCOUNT_A, ADM_ACCOUNT_B] }),
    });
    const b = verdict.accounts.find(
      (account) => account.providerAccountId === ADM_ACCOUNT_B,
    )!;
    expect(b.adsInWindow).toBe(0);
    expect(b.bandPairCompleteEnoughFor14x14).toBe(false);
    expect(verdict.allBandsComplete).toBe(false);
  });
});


/*
  ── ROUND 6 ITEM 5: THE READBACK COUNTS WHAT HYDRATION COUNTS ───────────────
  `ad_band_aggregates` in HYDRATE_AD_DECISION_INPUTS_QUERY counts a missing
  link-click reading against a band only on a DECISION-BEARING day — one with
  impressions, spend, clicks, conversions or revenue. A wholly inert day with a
  NULL reading is not a gap and the engine admits the band.

  This verifier counted EVERY NULL, so it reported a band incomplete and a pair
  unusable on rows the decision never looks at: a readback that fails on rows
  the verdict does not read is measuring a different table than the one the
  verdict comes from. It now interpolates the same exported predicate
  (`AD_DAY_DECISION_BEARING_ACTIVITY_SQL`), so the two cannot drift.

  Each case below adds ONE row to a complete, admissible band pair, so a
  failure names the activity column that decided it.
*/
const ACT_BUSINESS_ID = "lcrepair-biz-9005";
const ACT_ACCOUNT = "act_lcrepair_9005";

interface ActivityRow {
  date: string;
  adId: string;
  linkClicks: number | null;
  spend?: number;
  impressions?: number;
  clicks?: number;
  conversions?: number;
  revenue?: number;
}

async function insertActivityRow(row: ActivityRow) {
  const sql = getDb();
  await sql.query(
    `INSERT INTO meta_ad_daily
       (business_id, provider_account_id, date, campaign_id, adset_id, ad_id,
        account_timezone, account_currency, spend, impressions, clicks, reach,
        conversions, revenue, roas, link_clicks, payload_json,
        truth_state, validation_status, created_at, updated_at)
     VALUES ($1, $2, $3::date, 'camp_lcact', 'adset_lcact', $4,
             'UTC', 'USD', $5, $6, $7, 0, $8, $9, 0, $10::bigint,
             jsonb_build_object('ad_id', $4::text, 'actions',
               jsonb_build_array(jsonb_build_object('action_type', 'link_click', 'value', '9'))),
             'finalized', 'passed', $11::timestamptz, $11::timestamptz)
     ON CONFLICT (business_id, provider_account_id, date, ad_id) DO UPDATE SET
       spend = EXCLUDED.spend,
       impressions = EXCLUDED.impressions,
       clicks = EXCLUDED.clicks,
       conversions = EXCLUDED.conversions,
       revenue = EXCLUDED.revenue,
       link_clicks = EXCLUDED.link_clicks`,
    [
      ACT_BUSINESS_ID,
      ACT_ACCOUNT,
      row.date,
      row.adId,
      row.spend ?? 0,
      row.impressions ?? 0,
      row.clicks ?? 0,
      row.conversions ?? 0,
      row.revenue ?? 0,
      row.linkClicks,
      SEEDED_ROW_CLOCK,
    ],
  );
}

function actOptions(
  overrides: Partial<Parameters<typeof runLinkClickReadbackVerify>[0]["options"]> = {},
) {
  return verifyOptions({
    businessId: ACT_BUSINESS_ID,
    admissibilityCutoff: "2026-09-06T23:59:59.999Z",
    ...overrides,
  });
}

describe.runIf(SEAM)("link-click readback uses the decision-bearing activity predicate", () => {
  beforeEach(async () => {
    const sql = getDb();
    await sql.query(`DELETE FROM meta_ad_daily WHERE business_id = $1`, [ACT_BUSINESS_ID]);
    /*
      A COMPLETE, USABLE BAND PAIR. One ad, one measured decision-bearing day
      in each band, both carrying a positive link-click total — so the window
      starts complete and every case below is about the ONE row it adds.
    */
    await insertActivityRow({
      date: "2026-08-25", adId: "ad-ACT", linkClicks: 40,
      spend: 60, impressions: 30_000, clicks: 400, conversions: 2, revenue: 240,
    });
    await insertActivityRow({
      date: "2026-08-12", adId: "ad-ACT", linkClicks: 50,
      spend: 60, impressions: 30_000, clicks: 400, conversions: 3, revenue: 300,
    });
  });

  afterAll(async () => {
    const sql = getDb();
    await sql.query(`DELETE FROM meta_ad_daily WHERE business_id = $1`, [ACT_BUSINESS_ID]);
  });

  it("reports the seeded pair as complete before any extra row", async () => {
    const verdict = await runLinkClickReadbackVerify({ db: db(), options: actOptions() });
    expect(verdict.allBandsComplete).toBe(true);
    expect(verdict.totals.adsWithUsableBandPair).toBe(1);
    expect(verdict.totals.rowsStillAbsent).toBe(0);
  });

  it("does NOT let a wholly inert NULL day block completion or the usable pair", async () => {
    /*
      Zero on every activity column. Hydration does not count this row's
      missing reading against the band, so neither may the readback — otherwise
      an operator is told to repair a day the engine already accepts.
    */
    await insertActivityRow({ date: "2026-08-26", adId: "ad-ACT", linkClicks: null });
    const verdict = await runLinkClickReadbackVerify({ db: db(), options: actOptions() });
    expect(verdict.totals.rowsExpected).toBe(3);
    expect(verdict.totals.rowsStillAbsent).toBe(0);
    expect(verdict.totals.adsWithUsableBandPair).toBe(1);
    expect(verdict.allBandsComplete).toBe(true);
  });

  it.each([
    ["clicks", { clicks: 25 }],
    ["conversions", { conversions: 1 }],
    ["revenue", { revenue: 120 }],
    ["impressions", { impressions: 900 }],
    ["spend", { spend: 15 }],
  ])(
    "a NULL row with %s alone DOES block completion and the usable pair",
    async (_column, activity) => {
      /*
        Each of these is a day the decision reads: its clicks, conversions or
        revenue enter the band aggregate, so a link-click denominator missing
        that day is a fraction of the window presented as the whole of it. The
        spend/impressions rows are the two the old predicate already caught,
        kept here so a regression that narrowed it back would fail too.
      */
      await insertActivityRow({
        date: "2026-08-26",
        adId: "ad-ACT",
        linkClicks: null,
        ...activity,
      });
      const verdict = await runLinkClickReadbackVerify({ db: db(), options: actOptions() });
      expect(verdict.totals.rowsExpected).toBe(3);
      expect(verdict.totals.rowsStillAbsent).toBe(1);
      expect(verdict.totals.adsWithUsableBandPair).toBe(0);
      expect(verdict.allBandsComplete).toBe(false);
      const recent = verdict.accounts[0]!.bands.find((band) => band.band === "recent14")!;
      expect(recent.incompleteReasons).toContain(
        "1_absent_rows_repairable_from_stored_payload",
      );
    },
  );

  it("keeps the cutoff and finalized/passed predicates on top of the activity one", async () => {
    /*
      The two contracts compose: a decision-bearing NULL row that is ALSO
      inadmissible is excluded, so widening the activity test did not reopen
      the admissibility door.
    */
    await insertActivityRow({
      date: "2026-08-26", adId: "ad-ACT", linkClicks: null, clicks: 25,
    });
    const sql = getDb();
    await sql.query(
      `UPDATE meta_ad_daily SET truth_state = 'provisional'
        WHERE business_id = $1 AND ad_id = 'ad-ACT' AND date = '2026-08-26'::date`,
      [ACT_BUSINESS_ID],
    );
    const verdict = await runLinkClickReadbackVerify({ db: db(), options: actOptions() });
    expect(verdict.totals.rowsExpected).toBe(2);
    expect(verdict.totals.rowsStillAbsent).toBe(0);
    expect(verdict.allBandsComplete).toBe(true);
  });

  it("still reports an explicitly requested account that answered with nothing", async () => {
    // The empty-account behaviour is unchanged by the activity predicate.
    const verdict = await runLinkClickReadbackVerify({
      db: db(),
      options: actOptions({ providerAccountIds: [ACT_ACCOUNT, "act_lcrepair_9005b"] }),
    });
    expect(verdict.accounts.map((account) => account.providerAccountId)).toEqual([
      ACT_ACCOUNT,
      "act_lcrepair_9005b",
    ]);
    expect(verdict.allBandsComplete).toBe(false);
  });
});
