/**
 * The link-click measurement survives the trip to disk, at exact ad-day grain,
 * through BOTH writers the codebase has — against a real PostgreSQL.
 *
 * WHY THIS FILE EXISTS. `meta_ad_daily.link_clicks` was created
 * `BIGINT NOT NULL DEFAULT 0`, so for its whole life the column had one way to
 * say "no link clicks" and it was the same value an account uses to say "zero
 * people clicked". `lib/migrations.ts` widened it (`ALTER COLUMN link_clicks
 * DROP NOT NULL`) and `lib/meta/warehouse.ts` stopped answering on the
 * provider's behalf — the bind is `row.linkClicks ?? null`, and the ON CONFLICT
 * arm is a TWO-argument `COALESCE(EXCLUDED.link_clicks, meta_ad_daily.link_clicks)`
 * where a three-argument form with a literal `0` in the middle used to make the
 * "keep what is stored" arm unreachable. Nothing ran that proved either half
 * against a database. Every existing assertion about this column is either a
 * template-SQL string match in `lib/meta/warehouse.test.ts` (which can only see
 * the text the writer sends, never what PostgreSQL stores) or an in-memory
 * presence check. A string match cannot tell a stored NULL from a stored 0, and
 * that distinction is the entire contract.
 *
 * WHY IT MATTERS NOW. Measured read-only against production on 2026-09-07:
 *
 *   meta_ad_daily.link_clicks       rows    NULL    = 0    > 0
 *     2026-06                      14540       0   11864   2676
 *     2026-07                      16452       0   16394     58
 *     2026-08                      11948    5676    6272      0
 *     2026-09                       2327    2327       0      0
 *
 *   meta_creative_daily.link_clicks rows    NULL    = 0    > 0
 *     2026-09                       2222       0     786   1436
 *
 * The two grains disagree completely: the creative-day writer is still storing
 * real positive counts, and the ad-day writer has stored nothing but absence
 * since August. The source is not gone — over the last 40 days, 15,544 ad-day
 * rows carry a payload, 12,900 of them carry an `actions` key, 9,489 contain an
 * `action_type = 'link_click'` entry, and 0 carry `inline_link_clicks`. So the
 * ad-day column is being restored from `actions[]` in `lib/api/meta.ts`, which
 * is where it stopped. The moment that lands, this file is what stands between
 * a restored measurement and a writer that quietly drops it again.
 *
 * THE TWO WRITER MODES, NAMED. `lib/api/meta.ts` feeds ONE `adRows` array into
 * one of two calls, chosen by whether a finalization completeness proof exists:
 *
 *   1. `replaceMetaAdDailySlice` — the PROOF-GATED SLICE REPLACEMENT. Runs the
 *      upsert inside `runInTransaction` and then DELETEs every ad_id of that
 *      (business, account, date) absent from the supplied rows.
 *   2. `upsertMetaAdDailyRows(rows, { writeMode: "authoritative_fact" })` — the
 *      DIRECT AUTHORITATIVE UPSERT. The same INSERT ... ON CONFLICT, with no
 *      transaction wrapper and no prune.
 *
 * They share a code path today; nothing enforces that they keep sharing it, and
 * a transaction-scoped writer is exactly where a per-column regression hides
 * from a template-SQL test. Both are driven here, and every case below is run
 * against both. `upsertMetaCreativeDailyRows` — the creative-day grain, and the
 * DEFAULT grain the Assets table reads — is driven for the cases where the same
 * measurement applies, including its in-memory ad-to-creative fold.
 *
 * WHY REAL POSTGRES AND NOT A MOCK. Every claim here is a claim about what a
 * previous statement COMMITTED: that a bound `null` reached the column as NULL
 * rather than as the column's `DEFAULT 0`; that `COALESCE(EXCLUDED, stored)`
 * chose the stored value on a later write that supplied nothing; that a measured
 * 0 still won that comparison. A template-SQL mock answers all three with
 * whatever the test author typed. The rows are written through the shipped
 * writers and read back through the shipped readers (`getMetaAdDailyRange`,
 * `getMetaCreativeDailyRange`); no query in this file restates production SQL.
 *
 * THE OVER-CORRECTION GUARD IS TESTED AS HARD AS THE FIX. The obvious wrong fix
 * for "an absent count must not overwrite a measurement" is to treat 0 as
 * absent — `NULLIF(EXCLUDED.link_clicks, 0)`, or `if (!linkClicks) return`.
 * That would silently swallow the single most common real measurement this
 * column carries: production stores 192,464 zero ad-days. `a measured zero
 * overwrites a stored positive count` and `a measured zero is not swallowed by
 * the absent-value arm` fail if anyone reaches for it.
 *
 * Runs only inside an ephemeral-database seam (`ADSECUTE_EPHEMERAL_DB_SEAM=1`),
 * because outside one `DATABASE_URL` in this repository points at PRODUCTION.
 * Under a plain `npx vitest run` the default include still COLLECTS this file
 * and `describe.skipIf(!SEAM)` reports every case as skipped, which reads green
 * — so the file is registered as a stage of
 * `scripts/ephemeral-postgres-migrations-check.ts`, whose `runChildVitest`
 * fails the gate on a skipped or short run. Adding or removing a case here
 * means updating the expected passing count in that registration.
 *
 * IT WRITES NULLs INTO A SHARED EPHEMERAL DATABASE, DELIBERATELY. That is the
 * measurement. `scripts/ephemeral-postgres-creative-null-presence-seam-child.ts`
 * restores `NOT NULL` on both columns part-way through its own run and its
 * precondition is table-wide for exactly this reason — it clears every blocking
 * row, not only its own business's — so the two stages compose in either order.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import { createMetaFinalizationCompletenessProof } from "@/lib/meta/finalization-proof";
import {
  getMetaAdDailyRange,
  getMetaCreativeDailyRange,
  replaceMetaAdDailySlice,
  upsertMetaAdDailyRows,
  upsertMetaCreativeDailyRows,
} from "@/lib/meta/warehouse";
import type {
  MetaAdDailyRow,
  MetaCreativeDailyRow,
} from "@/lib/meta/warehouse-types";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

/** Ids chosen not to collide with any other stage of the seam gate. */
const OWNER_EMAIL = "ad-day-link-click-persistence@example.invalid";
const ACCOUNT_ID = "act_link_click_persistence_8101";

/**
 * The window every read in this file covers.
 *
 * Each case owns its own date inside it, so a case can never read a row another
 * case wrote and the ad-day grain is what is actually being asserted.
 */
const RANGE_START = "2026-05-01";
const RANGE_END = "2026-05-31";

let businessId = "";

async function seed() {
  const sql = getDb();
  const [owner] = await sql<{ id: string }>`
    INSERT INTO users (name, email, password_hash)
    VALUES ('Ad-day link click seam', ${OWNER_EMAIL}, 'unused')
    RETURNING id
  `;
  if (!owner?.id) throw new Error("Could not create the seam owner.");
  const [business] = await sql<{ id: string }>`
    INSERT INTO businesses (name, owner_id)
    VALUES ('Ad-day link click seam', ${owner.id})
    RETURNING id
  `;
  if (!business?.id) throw new Error("Could not create the seam business.");
  businessId = business.id;
  const [account] = await sql<{ id: string }>`
    INSERT INTO provider_accounts (provider, external_account_id, account_name)
    VALUES ('meta', ${ACCOUNT_ID}, 'Ad-day link click seam')
    RETURNING id
  `;
  if (!account?.id) throw new Error("Could not create the seam account.");
  await sql`
    INSERT INTO business_provider_accounts (
      business_id, provider, provider_account_ref_id, provider_account_id
    ) VALUES (${businessId}, 'meta', ${account.id}, ${ACCOUNT_ID})
  `;
}

/**
 * `linkClicks` is OMITTED when the caller passes `undefined`, not set to
 * `undefined`.
 *
 * A mapper that only assigns the field when the provider supplied one produces
 * a row on which the property does not exist at all, and `row.linkClicks ?? null`
 * has to answer for that shape as well as for an explicit `null`. Spreading a
 * conditional object is the only way to reproduce it — `{ linkClicks: undefined }`
 * is a different object.
 */
function adRow(input: {
  adId: string;
  date: string;
  linkClicks?: number | null;
  spend?: number;
}): MetaAdDailyRow {
  return {
    businessId,
    providerAccountId: ACCOUNT_ID,
    date: input.date,
    accountTimezone: "UTC",
    accountCurrency: "USD",
    sourceSnapshotId: null,
    sourceRunId: "link-click-seam-run",
    campaignId: "camp_link_click",
    adsetId: "adset_link_click",
    adId: input.adId,
    adNameCurrent: input.adId,
    adNameHistorical: input.adId,
    adStatus: "ACTIVE",
    spend: input.spend ?? 120,
    impressions: 5000,
    clicks: 300,
    reach: 4200,
    frequency: 1.19,
    conversions: 6,
    revenue: 480,
    roas: 4,
    cpa: 20,
    ctr: 6,
    cpc: 0.4,
    ...(input.linkClicks === undefined ? {} : { linkClicks: input.linkClicks }),
  };
}

function creativeRow(input: {
  creativeId: string;
  date: string;
  adId: string;
  linkClicks?: number | null;
}): MetaCreativeDailyRow {
  return {
    businessId,
    providerAccountId: ACCOUNT_ID,
    date: input.date,
    accountTimezone: "UTC",
    accountCurrency: "USD",
    sourceSnapshotId: null,
    sourceRunId: "link-click-seam-run",
    campaignId: "camp_link_click",
    adsetId: "adset_link_click",
    adId: input.adId,
    creativeId: input.creativeId,
    creativeName: input.creativeId,
    headline: null,
    primaryText: null,
    destinationUrl: null,
    thumbnailUrl: null,
    assetType: "image",
    spend: 60,
    impressions: 2500,
    clicks: 150,
    reach: 2100,
    frequency: 1.19,
    conversions: 3,
    revenue: 240,
    roas: 4,
    cpa: 20,
    ctr: 6,
    cpc: 0.4,
    ...(input.linkClicks === undefined ? {} : { linkClicks: input.linkClicks }),
  };
}

function adProof(date: string) {
  return createMetaFinalizationCompletenessProof({
    businessId,
    providerAccountId: ACCOUNT_ID,
    date,
    scope: "ad",
    sourceRunId: "link-click-seam-run",
    complete: true,
    validationStatus: "passed",
  });
}

/** MODE 1: the proof-gated slice replacement. */
async function writeSlice(rows: MetaAdDailyRow[]) {
  await replaceMetaAdDailySlice({ rows, proof: adProof(rows[0]!.date) });
}

/** MODE 2: the direct authoritative upsert. */
async function writeDirect(rows: MetaAdDailyRow[]) {
  await upsertMetaAdDailyRows(rows, { writeMode: "authoritative_fact" });
}

const AD_WRITERS: Array<{
  name: string;
  write: (rows: MetaAdDailyRow[]) => Promise<void>;
  /** Distinct day per writer, so the two modes can never read each other's row. */
  day: (suffix: string) => string;
}> = [
  { name: "proof-gated slice replacement", write: writeSlice, day: (s) => `2026-05-1${s}` },
  { name: "direct authoritative upsert", write: writeDirect, day: (s) => `2026-05-2${s}` },
];

/**
 * Read one ad-day back through the SHIPPED reader.
 *
 * `getMetaAdDailyRange` is what the product uses, and it maps the column with
 * `row.link_clicks == null ? null : Number(row.link_clicks)` — so a stored NULL
 * and a stored 0 are still distinguishable after the read, which is the half of
 * the contract a write-side assertion alone cannot reach.
 */
async function readAdDay(adId: string, date: string) {
  const rows = await getMetaAdDailyRange({
    businessId,
    startDate: RANGE_START,
    endDate: RANGE_END,
    providerAccountIds: [ACCOUNT_ID],
  });
  return rows.find((row) => row.adId === adId && row.date === date) ?? null;
}

async function readCreativeDay(creativeId: string, date: string) {
  const rows = await getMetaCreativeDailyRange({
    businessId,
    startDate: RANGE_START,
    endDate: RANGE_END,
    providerAccountIds: [ACCOUNT_ID],
  });
  return rows.find((row) => row.creativeId === creativeId && row.date === date) ?? null;
}

/**
 * The stored row as PostgreSQL holds it, for the assertions the shipped reader
 * cannot make: whether `link_clicks` is literally NULL in the column (not merely
 * mapped to null), and whether a second identical write changed anything.
 */
async function storedAdDay(adId: string, date: string) {
  const sql = getDb();
  const [row] = await sql<{
    link_clicks: string | null;
    link_clicks_is_null: boolean;
    spend: string;
    truth_version: number;
  }>`
    SELECT
      link_clicks,
      (link_clicks IS NULL) AS link_clicks_is_null,
      spend,
      truth_version
    FROM meta_ad_daily
    WHERE business_id = ${businessId}
      AND provider_account_id = ${ACCOUNT_ID}
      AND ad_id = ${adId}
      AND date = ${date}::date
  `;
  return row ?? null;
}

/**
 * The SHAPE of the repair backfill's write, not its code.
 *
 * The repair half of this item projects the measurement already stored in the
 * row's own `payload_json` into the column with a single-column UPDATE, and
 * deliberately does not round-trip through `upsertMetaAdDailyRows` — that would
 * rewrite forty fact columns to repair one. What is reproduced here is exactly
 * what that makes true of the row afterwards: `link_clicks` and `updated_at`
 * moved, no fact column and no `truth_version` did.
 */
async function repairLinkClicksOutOfBand(
  adIds: string[],
  date: string,
  value: number,
) {
  const sql = getDb();
  await sql`
    UPDATE meta_ad_daily
    SET link_clicks = ${value}, updated_at = now()
    WHERE business_id = ${businessId}
      AND provider_account_id = ${ACCOUNT_ID}
      AND ad_id = ANY(${adIds}::text[])
      AND date = ${date}::date
  `;
}

describe.skipIf(!SEAM)("ad-day link-click persistence (real PostgreSQL)", () => {
  beforeAll(async () => {
    await seed();
  });

  describe.each(AD_WRITERS)("$name", ({ write, day }) => {
    it("persists a positive count at exact ad-day grain", async () => {
      const date = day("1");
      // A second ad on the SAME day, and the same ad on a NEIGHBOURING day,
      // both carrying different counts: if the writer bound the wrong tuple
      // offset the values would land on each other rather than go missing.
      await write([
        adRow({ adId: "lc_pos_a", date, linkClicks: 137 }),
        adRow({ adId: "lc_pos_b", date, linkClicks: 42 }),
      ]);
      await write([adRow({ adId: "lc_pos_a", date: day("2"), linkClicks: 9 })]);

      expect((await readAdDay("lc_pos_a", date))?.linkClicks).toBe(137);
      expect((await readAdDay("lc_pos_b", date))?.linkClicks).toBe(42);
      expect((await readAdDay("lc_pos_a", day("2")))?.linkClicks).toBe(9);
    });

    it("persists a measured zero as 0, not as NULL and not as absent", async () => {
      const date = day("3");
      await write([adRow({ adId: "lc_zero", date, linkClicks: 0 })]);

      const stored = await storedAdDay("lc_zero", date);
      expect(stored?.link_clicks_is_null).toBe(false);
      expect(Number(stored?.link_clicks)).toBe(0);
      // And the shipped reader keeps it a measurement rather than reporting the
      // absence the presence sidecar would publish as "unavailable".
      expect((await readAdDay("lc_zero", date))?.linkClicks).toBe(0);
    });

    it("persists an unsupplied count as NULL and never coerces it to 0", async () => {
      const date = day("4");
      // Both shapes a mapper can produce: an explicit null, and a row on which
      // the property does not exist at all.
      await write([
        adRow({ adId: "lc_absent_null", date, linkClicks: null }),
        adRow({ adId: "lc_absent_missing", date }),
      ]);

      for (const adId of ["lc_absent_null", "lc_absent_missing"]) {
        const stored = await storedAdDay(adId, date);
        // The row exists — this is an absence in the column, not a missing row,
        // and not the column's own `DEFAULT 0` filling an omitted INSERT.
        expect(stored, `${adId} must have a stored row`).not.toBeNull();
        expect(stored?.link_clicks_is_null, `${adId} must store NULL`).toBe(true);
        expect((await readAdDay(adId, date))?.linkClicks).toBeNull();
      }
    });

    it("repairs NULL to the measured value once it is finally supplied", async () => {
      const date = day("5");
      await write([adRow({ adId: "lc_repair", date, linkClicks: null })]);
      expect((await storedAdDay("lc_repair", date))?.link_clicks_is_null).toBe(true);

      // The repair path: the same ad-day, re-observed, now carrying a count.
      await write([adRow({ adId: "lc_repair", date, linkClicks: 88 })]);

      expect((await readAdDay("lc_repair", date))?.linkClicks).toBe(88);
    });

    it("repairs NULL to a measured ZERO, which is also a measurement", async () => {
      const date = day("6");
      await write([adRow({ adId: "lc_repair_zero", date, linkClicks: null })]);
      expect((await storedAdDay("lc_repair_zero", date))?.link_clicks_is_null).toBe(true);

      await write([adRow({ adId: "lc_repair_zero", date, linkClicks: 0 })]);

      // A repair that lands 0 must leave the column NOT NULL. If the absent-value
      // arm ever grows a `NULLIF(..., 0)` this stays NULL and the repair silently
      // does nothing.
      expect((await storedAdDay("lc_repair_zero", date))?.link_clicks_is_null).toBe(false);
      expect((await readAdDay("lc_repair_zero", date))?.linkClicks).toBe(0);
    });

    it("does not regress a known count to absent when a resync supplies nothing", async () => {
      const date = day("7");
      await write([adRow({ adId: "lc_resync", date, linkClicks: 210 })]);
      // The re-sync that has no link-click value to offer. It must not overwrite
      // the measurement with an invented absence, and it must not sum into it.
      await write([adRow({ adId: "lc_resync", date, linkClicks: null })]);
      await write([adRow({ adId: "lc_resync", date })]);

      expect((await readAdDay("lc_resync", date))?.linkClicks).toBe(210);
    });

    it("does not double-count when the same ad-day is re-observed with a count", async () => {
      const date = day("8");
      await write([adRow({ adId: "lc_nodup", date, linkClicks: 50 })]);
      await write([adRow({ adId: "lc_nodup", date, linkClicks: 50 })]);
      await write([adRow({ adId: "lc_nodup", date, linkClicks: 50 })]);

      // Three observations of the same 50, not 150. The measurement is a daily
      // total the provider restates, never an increment.
      expect((await readAdDay("lc_nodup", date))?.linkClicks).toBe(50);
    });

    it("lets a measured zero overwrite a stored positive count", async () => {
      const date = day("9");
      await write([adRow({ adId: "lc_down_to_zero", date, linkClicks: 64 })]);
      // A genuine re-measurement down to zero — the provider restating the day
      // after an attribution correction. This is the case that breaks if anyone
      // "fixes" the conflict arm by treating 0 as if it meant absent.
      await write([adRow({ adId: "lc_down_to_zero", date, linkClicks: 0 })]);

      const stored = await storedAdDay("lc_down_to_zero", date);
      expect(stored?.link_clicks_is_null).toBe(false);
      expect(Number(stored?.link_clicks)).toBe(0);
    });

    it("applies the identical payload twice to the identical row", async () => {
      const date = day("0");
      const payload = [adRow({ adId: "lc_idem", date, linkClicks: 77 })];
      await write(payload);
      const first = await storedAdDay("lc_idem", date);
      await write(payload);
      const second = await storedAdDay("lc_idem", date);

      expect(second?.link_clicks).toEqual(first?.link_clicks);
      expect(second?.spend).toEqual(first?.spend);
      // `truth_version` bumps only when truth_state or validation_status move,
      // so a re-application of the same payload must not advance it either.
      expect(second?.truth_version).toEqual(first?.truth_version);
    });
  });

  it("carries every value across the writer's 150-row chunk boundary", async () => {
    // `upsertMetaAdDailyRows` binds 40 values per row and chunks at 150, so the
    // placeholder offsets restart inside every chunk. A slip there does not lose
    // the column, it shifts it onto a neighbour — which is invisible to a
    // one-row test and invisible to a template-SQL string match.
    const date = "2026-05-15";
    const rows: MetaAdDailyRow[] = [];
    for (let index = 0; index < 210; index += 1) {
      rows.push(
        adRow({
          adId: `lc_chunk_${index}`,
          date,
          linkClicks: index % 3 === 0 ? index : index % 3 === 1 ? 0 : null,
        }),
      );
    }
    await upsertMetaAdDailyRows(rows, { writeMode: "authoritative_fact" });

    // Both sides of both chunk boundaries, and each of the three shapes.
    for (const index of [0, 1, 2, 148, 149, 150, 151, 208, 209]) {
      const expected = index % 3 === 0 ? index : index % 3 === 1 ? 0 : null;
      expect(
        (await readAdDay(`lc_chunk_${index}`, date))?.linkClicks,
        `row ${index} must read back as ${expected}`,
      ).toBe(expected);
    }
  });

  it("keeps a count written by one mode when the OTHER mode resyncs with nothing", async () => {
    // The two modes are chosen per sync by whether a completeness proof exists,
    // so the same ad-day is written by both across its life. A count measured
    // under one must not be erased by an absence arriving under the other.
    const dateA = "2026-05-16";
    await writeDirect([adRow({ adId: "lc_cross_a", date: dateA, linkClicks: 300 })]);
    await writeSlice([adRow({ adId: "lc_cross_a", date: dateA, linkClicks: null })]);
    expect((await readAdDay("lc_cross_a", dateA))?.linkClicks).toBe(300);

    const dateB = "2026-05-17";
    await writeSlice([adRow({ adId: "lc_cross_b", date: dateB, linkClicks: 301 })]);
    await writeDirect([adRow({ adId: "lc_cross_b", date: dateB, linkClicks: null })]);
    expect((await readAdDay("lc_cross_b", dateB))?.linkClicks).toBe(301);
  });

  it("keeps an OUT-OF-BAND repaired count through a later sync that supplies nothing", async () => {
    // The repair half of this item projects the measurement that is already
    // inside the row's own `payload_json` into the column with a single-column
    // UPDATE, deliberately NOT round-tripping through `upsertMetaAdDailyRows`
    // (rewriting forty fact columns to repair one). That backfill is only
    // durable if the very next authoritative sync — which still supplies
    // nothing for these days — leaves the repaired value alone. That property
    // belongs to the conflict clause here, not to the backfill, so it is pinned
    // here.
    //
    // A date per mode: the slice replacement prunes by (business, account,
    // DATE), so putting both modes' ads on one day would make the slice delete
    // the direct mode's row and the case would be measuring the prune instead.
    const directDate = "2026-05-25";
    const sliceDate = "2026-05-26";
    await writeDirect([adRow({ adId: "lc_repaired", date: directDate, linkClicks: null })]);
    await writeSlice([adRow({ adId: "lc_repaired_b", date: sliceDate, linkClicks: null })]);
    await repairLinkClicksOutOfBand(["lc_repaired"], directDate, 141);
    await repairLinkClicksOutOfBand(["lc_repaired_b"], sliceDate, 141);

    // The sync runs again, still with nothing to say about link clicks, under
    // each mode in turn.
    await writeDirect([adRow({ adId: "lc_repaired", date: directDate })]);
    await writeSlice([adRow({ adId: "lc_repaired_b", date: sliceDate })]);

    expect((await readAdDay("lc_repaired", directDate))?.linkClicks).toBe(141);
    expect((await readAdDay("lc_repaired_b", sliceDate))?.linkClicks).toBe(141);
  });

  it("loses a repaired count when a completeness-proved slice omits that ad", async () => {
    /*
      NOT a defect — the contract, pinned so it is a decision rather than a
      surprise, and so nobody "protects" the repaired column by weakening the
      prune.

      `replaceMetaAdDailySlice` deletes every ad_id of that (business, account,
      date) absent from the rows it was handed, and the completeness proof is
      the caller's assertion that the set IS the whole day. An ad dropped from
      that set is being declared not to exist on that day, so its row goes —
      and the repaired link-click count goes with the row, because the count is
      a column on it and not a separate record.

      The consequence for the repair half of this item is concrete: a backfill
      that repairs a day is durable against a sync that supplies nothing (the
      case above), and is NOT durable against a proved slice for the same day
      that no longer lists the ad. A repair run should therefore be re-runnable
      over a window rather than assumed permanent after one pass.
    */
    const date = "2026-05-27";
    await writeSlice([
      adRow({ adId: "lc_pruned_kept", date, linkClicks: null }),
      adRow({ adId: "lc_pruned_gone", date, linkClicks: null }),
    ]);
    await repairLinkClicksOutOfBand(["lc_pruned_kept", "lc_pruned_gone"], date, 141);

    // The next proved slice for the same day lists only one of the two ads.
    await writeSlice([adRow({ adId: "lc_pruned_kept", date })]);

    expect((await readAdDay("lc_pruned_kept", date))?.linkClicks).toBe(141);
    expect(await readAdDay("lc_pruned_gone", date)).toBeNull();
  });

  it("stores a count larger than a 32-bit integer without truncating it", async () => {
    // The column is BIGINT and an account-lifetime restatement can exceed 2^31.
    // Asserted because an INTEGER bind would silently wrap rather than fail.
    const date = "2026-05-18";
    await writeDirect([adRow({ adId: "lc_big", date, linkClicks: 4294967296 })]);
    expect((await readAdDay("lc_big", date))?.linkClicks).toBe(4294967296);
  });

  describe("creative-day grain", () => {
    it("persists positive, measured-zero and unsupplied counts distinctly", async () => {
      const date = "2026-05-19";
      await upsertMetaCreativeDailyRows([
        creativeRow({ creativeId: "cr_pos", date, adId: "ad_1", linkClicks: 512 }),
        creativeRow({ creativeId: "cr_zero", date, adId: "ad_2", linkClicks: 0 }),
        creativeRow({ creativeId: "cr_absent", date, adId: "ad_3", linkClicks: null }),
        creativeRow({ creativeId: "cr_missing", date, adId: "ad_4" }),
      ]);

      expect((await readCreativeDay("cr_pos", date))?.linkClicks).toBe(512);
      expect((await readCreativeDay("cr_zero", date))?.linkClicks).toBe(0);
      expect((await readCreativeDay("cr_absent", date))?.linkClicks).toBeNull();
      expect((await readCreativeDay("cr_missing", date))?.linkClicks).toBeNull();
    });

    it("does not fabricate a zero when every ad folding into the creative-day is absent", async () => {
      // The ad-to-creative fold runs in memory before the write, so `(a ?? 0) +
      // (b ?? 0)` here would turn "neither ad supplied a count" into a measured
      // 0 that no ON CONFLICT arm downstream could ever undo.
      const date = "2026-05-20";
      await upsertMetaCreativeDailyRows([
        creativeRow({ creativeId: "cr_fold_absent", date, adId: "ad_1", linkClicks: null }),
        creativeRow({ creativeId: "cr_fold_absent", date, adId: "ad_2" }),
      ]);

      expect((await readCreativeDay("cr_fold_absent", date))?.linkClicks).toBeNull();
    });

    it("sums the ads that DID supply a count, and a measured zero still counts", async () => {
      const date = "2026-05-21";
      await upsertMetaCreativeDailyRows([
        creativeRow({ creativeId: "cr_fold_sum", date, adId: "ad_1", linkClicks: 30 }),
        creativeRow({ creativeId: "cr_fold_sum", date, adId: "ad_2", linkClicks: 12 }),
      ]);
      expect((await readCreativeDay("cr_fold_sum", date))?.linkClicks).toBe(42);

      // A measured zero is a value, so it participates and cannot be mistaken
      // for the absence that would drop its sibling's measurement.
      await upsertMetaCreativeDailyRows([
        creativeRow({ creativeId: "cr_fold_zero", date, adId: "ad_1", linkClicks: 0 }),
        creativeRow({ creativeId: "cr_fold_zero", date, adId: "ad_2", linkClicks: 12 }),
      ]);
      expect((await readCreativeDay("cr_fold_zero", date))?.linkClicks).toBe(12);
    });

    it("repairs NULL to the measured value and does not regress it on resync", async () => {
      const date = "2026-05-22";
      await upsertMetaCreativeDailyRows([
        creativeRow({ creativeId: "cr_repair", date, adId: "ad_1", linkClicks: null }),
      ]);
      expect((await readCreativeDay("cr_repair", date))?.linkClicks).toBeNull();

      await upsertMetaCreativeDailyRows([
        creativeRow({ creativeId: "cr_repair", date, adId: "ad_1", linkClicks: 64 }),
      ]);
      expect((await readCreativeDay("cr_repair", date))?.linkClicks).toBe(64);

      // The resync that supplies nothing keeps the repaired measurement, and
      // does not add to it.
      await upsertMetaCreativeDailyRows([
        creativeRow({ creativeId: "cr_repair", date, adId: "ad_1", linkClicks: null }),
      ]);
      expect((await readCreativeDay("cr_repair", date))?.linkClicks).toBe(64);
    });

    it("lets a measured zero overwrite a stored positive count", async () => {
      // The creative grain's own over-correction guard. Its conflict arm is a
      // separate clause on a separate table, so the ad grain's guard does not
      // cover it: a `NULLIF(..., 0)` added to only one of the two would be
      // invisible here without this case.
      const date = "2026-05-24";
      await upsertMetaCreativeDailyRows([
        creativeRow({ creativeId: "cr_down_to_zero", date, adId: "ad_1", linkClicks: 96 }),
      ]);
      await upsertMetaCreativeDailyRows([
        creativeRow({ creativeId: "cr_down_to_zero", date, adId: "ad_1", linkClicks: 0 }),
      ]);

      expect((await readCreativeDay("cr_down_to_zero", date))?.linkClicks).toBe(0);
    });

    it("applies the identical payload twice to the identical row", async () => {
      const date = "2026-05-23";
      const payload = [
        creativeRow({ creativeId: "cr_idem", date, adId: "ad_1", linkClicks: 21 }),
        creativeRow({ creativeId: "cr_idem", date, adId: "ad_2", linkClicks: 21 }),
      ];
      await upsertMetaCreativeDailyRows(payload);
      const first = await readCreativeDay("cr_idem", date);
      await upsertMetaCreativeDailyRows(payload);
      const second = await readCreativeDay("cr_idem", date);

      // 42 both times: the fold sums the two ads within each call, and the
      // conflict arm replaces rather than accumulating across calls.
      expect(first?.linkClicks).toBe(42);
      expect(second?.linkClicks).toBe(42);
      expect(second?.spend).toBe(first?.spend);
    });
  });
});
