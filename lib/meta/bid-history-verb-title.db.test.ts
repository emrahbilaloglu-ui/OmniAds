/**
 * A bid write reads as a bid in Meta History — in BOTH persisted spellings.
 *
 * WHAT WAS WRONG. `handleMetaAdsetBidAction` journalled a verified cost-cap
 * change as `action = 'launch_adset'` and carried the real verb one level down
 * in `payload_request.operation`. The Writes journal titles a row with
 * `INITCAP(REPLACE(action_log.action, '_', ' '))`, so the operator's receipt for
 * a bid apply read **"Launch Adset | Broad prospecting"**. Observed in the
 * mounted product against the decision-card-apply harness, on the row the
 * ceremony had just written.
 *
 * WHY THE FIX HAD TO BE COMPATIBLE. `bid` was already legal — it is in
 * `MetaAdsActionKind`, in the `meta_ads_action_log_action_check` CHECK, and it
 * is what the unattended sweep writes (`lib/meta/scheduled-bid-runtime.ts`).
 * The route now writes it too. But every `launch_adset` + `apply_bid` row
 * already in the table keeps that shape forever: nothing rewrites history, so
 * the READER has to answer for both. That is what this file drives.
 *
 * WHAT IS REAL HERE. The title expression is not copied — it is extracted from
 * the shipped `META_HISTORY_READ_SQL` at run time and executed by PostgreSQL
 * against two literal rows. If someone edits the expression, this test runs the
 * edit.
 *
 * WHAT THIS FILE DOES NOT COVER. Titling is the second half of the answer.
 * The first is ADMISSION: the `INNER JOIN LATERAL` in the same SQL decides
 * whether a bid row resolves to an entity and therefore reaches the journal at
 * all, and a VALUES list cannot exercise a join against dimension tables.
 * `lib/meta/bid-history-writes-journal.db.test.ts` covers that half, by reading
 * seeded rows back through `readMetaHistoryJournal` on a migrated database.
 *
 * Runs only inside an ephemeral-database seam (`ADSECUTE_EPHEMERAL_DB_SEAM=1`),
 * because outside one `DATABASE_URL` in this repo points at PRODUCTION. It
 * needs no schema and no migration: the expression reads two columns, so the
 * rows are supplied as a VALUES list.
 */
import { describe, expect, it } from "vitest";

import { META_HISTORY_READ_SQL } from "@/lib/meta/history-read-model";
import { getDb } from "@/lib/db";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

/**
 * The action-log branch's title expression, lifted out of the shipped SQL.
 *
 * Anchored on the two ends that cannot move without the title moving with
 * them: it begins at the `INITCAP(REPLACE(` that opens the writes-journal
 * title and ends immediately before the action-log summary column.
 */
export function extractWritesJournalTitleExpression(sql: string): string {
  /*
    Anchored from the END, because `INITCAP(REPLACE(` appears seven times in
    this SQL and only one of them titles the action-log branch: the one that
    concatenates the resolved entity name, which appears exactly once.
  */
  const endMarker = "\n    ),\n    NULLIF(action_log.error_message";
  const end = sql.indexOf(endMarker);
  const start = end < 0 ? -1 : sql.lastIndexOf("INITCAP(REPLACE(", end);
  if (start < 0 || end < 0) {
    throw new Error(
      "the writes-journal title expression is no longer in META_HISTORY_READ_SQL",
    );
  }
  return sql.slice(start, end + "\n    )".length);
}

describe("the Writes journal title names the verb the write actually was", () => {
  it("extracts an expression that still consults the payload operation", () => {
    // Always runs: the compatibility branch is the whole of the fix, and its
    // absence is the defect returning.
    const expression = extractWritesJournalTitleExpression(META_HISTORY_READ_SQL);
    expect(expression).toContain("action_log.action = 'launch_adset'");
    expect(expression).toContain("payload_request->>'operation' = 'apply_bid'");
    expect(expression).toContain("THEN 'bid'");
  });

  it.runIf(SEAM)(
    "titles the new spelling and the old one identically, in PostgreSQL",
    async () => {
      const sql = getDb();
      const expression = extractWritesJournalTitleExpression(META_HISTORY_READ_SQL);
      // `getDb().query` returns the ROWS, not a pg result envelope.
      const rows = await sql.query<{ stored_action: string; title: string }>(`
        SELECT
          action_log.action AS stored_action,
          ${expression} AS title
        FROM (
          VALUES
            -- What the route writes now.
            ('bid',
             '{"operation":"apply_bid","scope_type":"adset","body":{"bid_amount":1320}}'::jsonb),
            -- What is already in the table, and always will be.
            ('launch_adset',
             '{"operation":"apply_bid","scope_type":"adset","body":{"bid_amount":1450}}'::jsonb),
            -- A real ad-set launch must NOT be renamed by the compatibility
            -- branch: it carries no apply_bid operation.
            ('launch_adset',
             '{"scope_type":"adset","body":{"campaign_id":"9000000000101"}}'::jsonb)
        ) AS action_log(action, payload_request),
        LATERAL (
          SELECT
            'Broad prospecting'::text AS entity_name,
            '9000000000201'::text AS entity_id,
            'adset'::text AS entity_type
        ) AS resolved
      `);

      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual({
        stored_action: "bid",
        title: "Bid | Broad prospecting",
      });
      expect(rows[1]).toEqual({
        stored_action: "launch_adset",
        title: "Bid | Broad prospecting",
      });
      expect(rows[2]).toEqual({
        stored_action: "launch_adset",
        title: "Launch Adset | Broad prospecting",
      });
    },
  );
});
