/**
 * A bid write REACHES the Writes journal, in both persisted spellings.
 *
 * WHAT THIS COVERS THAT ITS SIBLING DOES NOT.
 * `lib/meta/bid-history-verb-title.db.test.ts` extracts the title expression
 * from `META_HISTORY_READ_SQL` and runs it over a VALUES list. That proves how
 * a row is NAMED once it is on the page — and nothing about whether it gets
 * there. Admission is decided earlier, by the `INNER JOIN LATERAL` that
 * resolves an action-log row to an entity: a row that resolves to no candidate
 * is dropped by the join before any title is computed, so a bid write could be
 * titled perfectly and still be invisible. The compatibility clause the fix
 * added lives in that join —
 *
 *     AND (
 *       action_log.payload_request->>'scope_type' = 'adset'
 *       OR action_log.action IN ('launch_adset', 'bid')
 *     )
 *
 * — and until this file existed no runnable test executed it.
 *
 * WHAT IS REAL HERE. This drives the shipped `readMetaHistoryJournal`, which
 * builds the SQL with `buildMetaHistoryReadSql` and hands it to PostgreSQL over
 * migrated tables. Nothing about the query is restated here: the rows are
 * seeded, the journal is asked for them, and the entries it returns are
 * asserted. An edit to the join or to the title is run by this test rather
 * than described by it.
 *
 * WHY THE THREE ROWS. They are the three shapes the table now holds:
 *   1. `action = 'bid'`      — what the route writes today, and what the
 *                              unattended sweep has always written
 *                              (`lib/meta/scheduled-bid-runtime.ts`).
 *   2. `action = 'launch_adset'` + `payload_request.operation = 'apply_bid'`
 *                            — the shape already in the table, which nothing
 *                              rewrites, so the reader answers for it forever.
 *   3. `action = 'launch_adset'` with no `apply_bid` operation
 *                            — a genuine ad-set launch, which the
 *                              compatibility branch must NOT rename. Without
 *                              this case the fix could satisfy the other two by
 *                              titling every launch "Bid".
 * A fourth row carries `action = 'bid'` with no `scope_type` at all, which is
 * the only thing the `OR action_log.action IN (...)` half of the join clause
 * admits on its own.
 *
 * Runs only inside an ephemeral-database seam (`ADSECUTE_EPHEMERAL_DB_SEAM=1`),
 * because outside one `DATABASE_URL` in this repository points at PRODUCTION.
 * Unlike its sibling it needs the migrated schema, so it must run against a
 * database the seam built.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { META_HISTORY_READ_SQL } from "@/lib/meta/history-read-model";
import { readMetaHistoryJournal } from "@/lib/meta/history-read-model";
import { getDb } from "@/lib/db";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

/** Ids chosen not to collide with any other stage of the seam gate. */
const OWNER_ID = "b1d51500-0000-4000-8000-00000000000f";
const BUSINESS_ID = "b1d51500-0000-4000-8000-0000000000b1";
const ACCOUNT_ID = "act_bidhistory_9001";
const OTHER_ACCOUNT_ID = "act_bidhistory_9002";
const CAPPED_ADSET = "7700000000201";
const LEGACY_ADSET = "7700000000202";
const LAUNCHED_ADSET = "7700000000203";
const SCOPELESS_ADSET = "7700000000204";

async function seed() {
  const sql = getDb();
  await sql.query(
    `INSERT INTO users (id, name, email, password_hash)
     VALUES ($1, 'Bid history seam', 'bid-history-seam@example.invalid', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [OWNER_ID],
  );
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, currency)
     VALUES ($1, 'Bid history seam', $2, 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS_ID, OWNER_ID],
  );

  for (const [adsetId, name] of [
    [CAPPED_ADSET, "Broad prospecting"],
    [LEGACY_ADSET, "Legacy prospecting"],
    [LAUNCHED_ADSET, "Newly launched set"],
    [SCOPELESS_ADSET, "Scopeless prospecting"],
  ] as const) {
    await sql.query(
      `INSERT INTO meta_adset_dimensions
         (business_id, provider_account_id, adset_id, adset_name_current)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, provider_account_id, adset_id) DO NOTHING`,
      [BUSINESS_ID, ACCOUNT_ID, adsetId, name],
    );
  }

  const rows: Array<{
    adId: string;
    action: string;
    payload: Record<string, unknown>;
    account: string;
  }> = [
    {
      adId: CAPPED_ADSET,
      action: "bid",
      account: ACCOUNT_ID,
      payload: {
        method: "POST",
        endpoint: `/${CAPPED_ADSET}`,
        scope_type: "adset",
        operation: "apply_bid",
        body: { bid_amount: 1320, currency: "USD" },
      },
    },
    {
      adId: LEGACY_ADSET,
      action: "launch_adset",
      account: ACCOUNT_ID,
      payload: {
        method: "POST",
        endpoint: `/${LEGACY_ADSET}`,
        scope_type: "adset",
        operation: "apply_bid",
        body: { bid_amount: 1450, currency: "USD" },
      },
    },
    {
      adId: LAUNCHED_ADSET,
      action: "launch_adset",
      account: ACCOUNT_ID,
      payload: {
        method: "POST",
        endpoint: "/act_bidhistory_9001/adsets",
        scope_type: "adset",
        body: { campaign_id: "7700000000101", name: "Newly launched set" },
      },
    },
    {
      adId: SCOPELESS_ADSET,
      action: "bid",
      account: ACCOUNT_ID,
      payload: {
        method: "POST",
        endpoint: `/${SCOPELESS_ADSET}`,
        operation: "apply_bid",
        body: { bid_amount: 990, currency: "USD" },
      },
    },
    /*
      A bid write in a DIFFERENT account, seeded so the account fence is a
      result rather than an assumption: the journal is asked for ACCOUNT_ID and
      must not return this row. Its ad set is deliberately not in the
      dimensions of ACCOUNT_ID either.
    */
    {
      adId: CAPPED_ADSET,
      action: "bid",
      account: OTHER_ACCOUNT_ID,
      payload: {
        scope_type: "adset",
        operation: "apply_bid",
        body: { bid_amount: 4444 },
      },
    },
  ];

  for (const row of rows) {
    await sql.query(
      `INSERT INTO meta_ads_action_log
         (business_id, ad_id, action, source, status, provider_account_id,
          payload_request, requested_at, verified_at)
       VALUES ($1, $2, $3, 'ui_manual', 'success', $4, $5::jsonb, now(), now())`,
      [BUSINESS_ID, row.adId, row.action, row.account, JSON.stringify(row.payload)],
    );
  }
}

async function unseed() {
  const sql = getDb();
  // The action log cascades from businesses; the dimensions do not.
  await sql.query(`DELETE FROM meta_adset_dimensions WHERE business_id = $1`, [
    BUSINESS_ID,
  ]);
  await sql.query(`DELETE FROM businesses WHERE id = $1`, [BUSINESS_ID]);
  await sql.query(`DELETE FROM users WHERE id = $1`, [OWNER_ID]);
}

describe("the Writes journal admits a bid write in both spellings", () => {
  it("keeps the compatibility clause in the join that decides admission", () => {
    // Always runs. The join clause is what lets a 'bid' row resolve to an ad
    // set at all; its removal is the defect returning in a form the title
    // expression alone would never notice.
    expect(META_HISTORY_READ_SQL).toContain(
      "OR action_log.action IN ('launch_adset', 'bid')",
    );
  });

  describe.runIf(SEAM)("against the migrated schema", () => {
    let entries: Awaited<
      ReturnType<typeof readMetaHistoryJournal>
    >["entries"] = [];

    beforeAll(async () => {
      await seed();
      const answer = await readMetaHistoryJournal({
        query: {
          businessId: BUSINESS_ID,
          providerAccountId: ACCOUNT_ID,
          kind: "writes",
          entity: null,
          label: null,
          outcome: null,
          from: null,
          to: null,
          q: null,
          cursor: null,
          limit: 50,
        },
        account: {
          id: ACCOUNT_ID,
          name: "Bid history seam",
          currency: "USD",
          timezone: "UTC",
        },
      });
      entries = answer.entries;
    });

    afterAll(async () => {
      await unseed();
    });

    /** The journal entry for one seeded ad set, or a readable failure. */
    function entryFor(adsetId: string) {
      const found = entries.filter((entry) => entry.entity.id === adsetId);
      expect(
        found,
        `the Writes journal returned ${found.length} rows for ${adsetId}, not 1`,
      ).toHaveLength(1);
      return found[0];
    }

    it("returns the new-shaped bid row, titled as a bid", () => {
      const entry = entryFor(CAPPED_ADSET);
      // Admission: the INNER JOIN LATERAL resolved it to its ad set.
      expect(entry.entity.type).toBe("adset");
      expect(entry.entity.name).toBe("Broad prospecting");
      expect(entry.title).toBe("Bid | Broad prospecting");
    });

    it("returns the legacy launch_adset + apply_bid row, titled as a bid", () => {
      const entry = entryFor(LEGACY_ADSET);
      expect(entry.entity.type).toBe("adset");
      expect(entry.title).toBe("Bid | Legacy prospecting");
      // The stored value is not rewritten — the detail carries it verbatim, so
      // the journal reads the row rather than correcting it.
      expect((entry.detail as { action?: string } | null)?.action).toBe(
        "launch_adset",
      );
    });

    it("leaves a genuine ad-set launch named as a launch", () => {
      const entry = entryFor(LAUNCHED_ADSET);
      expect(entry.entity.type).toBe("adset");
      expect(entry.title).toBe("Launch Adset | Newly launched set");
    });

    it("admits a bid row whose payload lost its scope_type", () => {
      // The half of the join clause that `scope_type = 'adset'` cannot cover.
      const entry = entryFor(SCOPELESS_ADSET);
      expect(entry.entity.type).toBe("adset");
      expect(entry.title).toBe("Bid | Scopeless prospecting");
    });

    it("does not leak the other account's bid write into this account", () => {
      expect(entries.map((entry) => entry.entity.id)).toEqual(
        expect.arrayContaining([CAPPED_ADSET]),
      );
      // Exactly the four seeded for THIS account, and nothing else.
      expect(entries).toHaveLength(4);
    });
  });
});
