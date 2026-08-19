import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Two live writers reach the config-history tables, and only one used to ask
 * whether anything had changed.
 *
 * `appendMetaCurrentConfigHistory` filters transitions under a lock. The daily
 * upsert's side effect did not, and it runs on every sync of the account's own
 * provisional today — so an unchanged ad set was appended once per sync. On one
 * real account that was ~11k rows a day across 164 distinct configurations, and
 * it grew these tables until the History journal could not be read inside its
 * query budget at all.
 *
 * The defect is invisible to a correctness test: every row written was true,
 * there were simply hundreds of copies of it. So the guard is pinned on the
 * call, not on an outcome.
 */
const warehouse = readFileSync("lib/meta/warehouse.ts", "utf8");

describe("config history has exactly one author", () => {
  it("the daily writers do not append config history at all", () => {
    // Two authors with two notions of the same configuration is what filled
    // this table with changes nobody made: the sync path builds daily rows with
    // STICKY mixed flags (correct for a daily fact) while the `getCampaigns`
    // read path uses the raw response, and those flags are inside the
    // configuration fingerprint. The two alternated, and History reported every
    // alternation as "Campaign configuration changed".
    expect(warehouse).not.toContain("appendMetaCampaignConfigHistoryRows(chunk");
    expect(warehouse).not.toContain("appendMetaAdSetConfigHistoryRows(chunk");
    // And the option that used to switch it must be gone, not merely unused —
    // an inert option reads as a supported choice.
    expect(warehouse).not.toContain("appendConfigHistory");
  });

  it("leaves appendMetaCurrentConfigHistory as the author, still filtering transitions", () => {
    const writer = warehouse.slice(
      warehouse.indexOf("export async function appendMetaCurrentConfigHistory"),
      warehouse.indexOf("async function filterMetaConfigTransitions"),
    );
    expect(writer).toContain('table: "meta_campaign_config_history"');
    expect(writer).toContain('table: "meta_adset_config_history"');
    expect(writer).toContain("lockMetaConfigHistoryEntities");
  });
});

describe("the transition filter fails toward writing", () => {
  it("keeps every row when the latest-fingerprint read gives nothing usable", () => {
    // The two mistakes are not symmetric. A duplicate costs a row the History
    // read already treats as a non-change; assuming "unchanged" would discard a
    // real configuration change that nothing else records.
    const filter = warehouse.slice(
      warehouse.indexOf("async function filterMetaConfigTransitions"),
      warehouse.indexOf("function buildMetaConfigHistoryFingerprint"),
    );
    expect(filter).toContain("Array.isArray(latest) ? latest : []");
  });
});

describe("the transition filter compares what will be stored", () => {
  /**
   * The appenders normalise a constrained bid strategy with no bid value away
   * before writing, so the stored fingerprint is the hash of the stripped row.
   * Comparing the raw row against it can never match for those campaigns, so
   * the guard reported a transition every pass and suppressed nothing — a guard
   * that exists and does not work, which is worse than an absent one because it
   * reads as covered.
   */
  it("strips the same fields the appender strips before hashing", () => {
    const filter = warehouse.slice(
      warehouse.indexOf("async function filterMetaConfigTransitions"),
      warehouse.indexOf("async function lockMetaConfigHistoryEntities"),
    );
    expect(filter).toContain("stripIncompleteConstrainedBidFields(row as never)");

    // And the appenders must still be the ones doing that stripping on write,
    // or the two sides drift apart again in the other direction.
    expect(warehouse).toContain(
      ".map((row) => stripIncompleteConstrainedBidFields(row))",
    );
  });
});
