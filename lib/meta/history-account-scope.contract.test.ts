import { describe, expect, it } from "vitest";

import { META_HISTORY_READ_SQL } from "@/lib/meta/history-read-model";

/**
 * Every account-scoped correlation in the History journal must PROVE the
 * selected physical account.
 *
 * The journal is one large SQL string with five independent correlations —
 * snapshots, operator responses, provider writes, accrued outcomes, and the
 * change-attribution read that decides whether "we caused this". Each one used
 * to reach its rows through a business id plus a rec id, an entity id, or a
 * dimension row. That was survivable while a rec id could only mean one thing;
 * D-M011 makes two assigned accounts able to hold the same rec id on the same
 * day, and every one of those correlations then becomes a way for one account's
 * journal to show another account's history.
 *
 * ## Why structural
 *
 * The defect is a MISSING predicate, and a runtime test only catches a missing
 * predicate it was written to look for. The real-PostgreSQL evidence in
 * `scripts/ephemeral-postgres-decision-identity-seam.ts` (I9-I12) proves the
 * behaviour end to end against two seeded accounts; this proves the predicates
 * are still in the text, so a rewrite that drops one fails here even before the
 * seam is run.
 *
 * Neither is sufficient alone: this cannot tell whether a predicate is
 * CORRECT, and the seam cannot tell whether a branch it did not seed is
 * scoped. The comment is here so a future reader does not delete one believing
 * the other covers it.
 */

/** Collapse whitespace so a reflowed query does not read as a missing rule. */
const SQL = META_HISTORY_READ_SQL.replace(/\s+/g, " ");

function requires(fragment: string) {
  return SQL.includes(fragment.replace(/\s+/g, " "));
}

describe("the History journal proves the physical account", () => {
  it("reads a non-empty query, so a passing run means something", () => {
    expect(SQL.length).toBeGreaterThan(2000);
  });

  /*
   * The snapshot CTE is load-bearing: four correlations resolve against it, so
   * an unscoped CTE makes all four unscoped no matter what they add.
   */
  it("admits a snapshot by its own lineage, or by an exact unique-entity proof", () => {
    expect(requires("snapshot.provider_account_id = $2")).toBe(true);
    // The legacy path exists, and is a uniqueness proof rather than a guess.
    expect(requires("campaign_account_scope")).toBe(true);
    expect(requires("adset_account_scope")).toBe(true);
    expect(
      (SQL.match(/HAVING COUNT\(DISTINCT provider_account_id\) = 1/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  /*
   * Two accounts holding one scope, date and rec type produced ONE persisted_id
   * — two journal entries with the same identity.
   */
  it("puts the account in the snapshot's persisted identity", () => {
    expect(requires("COALESCE(snapshot.provider_account_id, 'unattributed') AS persisted_id")).toBe(
      true,
    );
  });

  it("matches an operator response on its own persisted lineage", () => {
    expect(requires("response.provider_account_id = $2")).toBe(true);
    // A legacy response is admitted only alongside a legacy snapshot; it is
    // never attached to a lineage-carrying one through the rec id.
    expect(
      requires(
        "response.provider_account_id IS NULL AND snapshot.provider_account_id IS NULL",
      ),
    ).toBe(true);
    expect(
      requires(
        "scoped.provider_account_id IS NOT DISTINCT FROM response.provider_account_id",
      ),
    ).toBe(true);
  });

  /*
   * meta_ads_action_log persists provider_account_id — insertMetaAdsActionLog
   * writes it alongside provider_account_ref_id — so the account here is a
   * direct equality. It must not be inferred from a dimension row: that is an
   * inference where a fact exists, and an incomplete one, because this log also
   * records campaign, ad-set and launch actions no ad dimension resolves.
   */
  it("matches a provider write on the log's own lineage, directly", () => {
    expect(requires("action_log.provider_account_id = $2")).toBe(true);
    expect(
      requires(
        "scoped.provider_account_id IS NOT DISTINCT FROM action_log.provider_account_id",
      ),
    ).toBe(true);
  });

  /*
   * THE FALLBACK THIS REPLACED. `outcome_log.provider_account_id IS NULL AND
   * linked.rec_id IS NOT NULL` admitted ANY unattributed outcome whose rec id
   * matched an account-scoped snapshot — so once two accounts could share a rec
   * id, account B's outcome appeared inside account A's journal.
   */
  it("does not let an unattributed outcome borrow the selected account", () => {
    expect(requires("outcome_log.provider_account_id = $2")).toBe(true);
    expect(
      requires(
        "scoped.provider_account_id IS NOT DISTINCT FROM outcome_log.provider_account_id",
      ),
    ).toBe(true);
    // The legacy arm now requires the LINKED snapshot to be legacy too.
    expect(requires("linked.provider_account_id IS NULL")).toBe(true);
    expect(
      SQL.includes(
        "outcome_log.provider_account_id IS NULL AND linked.rec_id IS NOT NULL )",
      ),
    ).toBe(false);
  });

  /*
   * Nothing is admitted on a rec id alone. Every LATERAL that joins on one must
   * also carry an account predicate — this counts them rather than naming them,
   * so a NEW rec-id correlation added later is covered without editing here.
   */
  it("never correlates on a rec id without an account predicate beside it", () => {
    const recIdJoins = (SQL.match(/scoped\.rec_id = [a-z_]+\.rec_id(_origin)?/g) ?? [])
      .length;
    const accountGuards = (
      SQL.match(
        /scoped\.provider_account_id IS NOT DISTINCT FROM [a-z_]+\.provider_account_id/g,
      ) ?? []
    ).length;
    expect(recIdJoins).toBeGreaterThan(0);
    expect(accountGuards).toBe(recIdJoins);
  });
});
