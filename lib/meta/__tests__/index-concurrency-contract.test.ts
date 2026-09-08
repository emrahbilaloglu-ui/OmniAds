/**
 * THE DEPLOY-TIME LOCK HAZARD ON A 6.44 GB RELATION.
 *
 * ── ROUND 17, ITEM 4 ────────────────────────────────────────────────────────
 * `meta_entity_state_history` is roughly 6.44 GB across ~4.4M rows in
 * production. `idx_meta_entity_state_history_manifest_delta` and the three
 * receipt indexes were registered as plain `CREATE INDEX`, which holds ACCESS
 * EXCLUSIVE on the relation for the WHOLE build — stalling every writer,
 * including the sync path, for the duration of a deploy.
 *
 * The rules pinned here, against the migration source rather than against a
 * preference:
 *
 *   - each of the four is built CONCURRENTLY;
 *   - each build is preceded by the invalid/mismatched-index repair, because
 *     an interrupted CONCURRENTLY build leaves an index that EXISTS, is named
 *     correctly and is INVALID — and `IF NOT EXISTS` matches on name only;
 *   - each build is followed by an UNSWALLOWED validity assertion, so a
 *     migration cannot report success with an unusable index;
 *   - the old occurrence index is dropped only AFTER the new UNIQUE one has
 *     been proven valid, so uniqueness is never briefly absent.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATIONS = readFileSync("lib/migrations.ts", "utf8");

const CONCURRENT_INDEXES = [
  "idx_meta_entity_state_history_manifest_delta",
  "meta_entity_observation_receipts_attempt_occurrence",
  "idx_meta_entity_observation_receipts_freshness_v2",
  "idx_meta_entity_observation_receipts_cohort_v2",
] as const;

describe("the Round 15/17 indexes are built without an exclusive lock", () => {
  it.each(CONCURRENT_INDEXES)("builds %s CONCURRENTLY", (indexName) => {
    const create = new RegExp(
      `CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS ${indexName}\\b`,
    );
    expect(MIGRATIONS).toMatch(create);
    // And NOT as a plain build anywhere: one plain CREATE reintroduces the
    // whole hazard on the next fresh deploy.
    expect(MIGRATIONS).not.toMatch(
      new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${indexName}\\b`),
    );
  });

  it.each(CONCURRENT_INDEXES)("repairs %s before building, and proves it after", (indexName) => {
    const repair = MIGRATIONS.indexOf(
      `buildInvalidIndexRepairQuery({\n                indexName: "${indexName}"`,
    );
    const build = MIGRATIONS.search(
      new RegExp(`CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS ${indexName}\\b`),
    );
    const contract = MIGRATIONS.indexOf(
      `buildIndexContractQuery({\n                indexName: "${indexName}"`,
    );
    expect(repair, `${indexName} repair`).toBeGreaterThan(-1);
    expect(contract, `${indexName} contract`).toBeGreaterThan(-1);
    // Repair -> build -> assert, in that order.
    expect(repair).toBeLessThan(build);
    expect(build).toBeLessThan(contract);
  });

  it("drops the old occurrence index only AFTER the new one is proven valid", () => {
    /*
      The ordering that keeps uniqueness continuous. `buildIndexContractQuery`
      RAISES on an invalid or missing index and is deliberately unswallowed, so
      a failed build aborts the ordered step and the drop below never runs.
    */
    const contract = MIGRATIONS.indexOf(
      `buildIndexContractQuery({\n                indexName: "meta_entity_observation_receipts_attempt_occurrence"`,
    );
    const drop = MIGRATIONS.indexOf(
      "DROP INDEX CONCURRENTLY IF EXISTS meta_entity_observation_receipts_occurrence",
    );
    expect(contract).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(-1);
    expect(contract).toBeLessThan(drop);
  });

  it("does not swallow the validity assertions", () => {
    /*
      The builds themselves are `.catch(() => {})` on purpose — a concurrent
      build can lose a race and the repair/assert pair handles it. The
      ASSERTIONS must not be: swallowing one is exactly how a migration reports
      success with an index PostgreSQL will never use.
    */
    for (const indexName of CONCURRENT_INDEXES) {
      const at = MIGRATIONS.indexOf(
        `buildIndexContractQuery({\n                indexName: "${indexName}"`,
      );
      // Scoped to the assertion's OWN call, not to whatever follows it: the
      // next statement is legitimately a swallowed concurrent DROP.
      const call = MIGRATIONS.slice(at, MIGRATIONS.indexOf("}),", at) + 3);
      expect(call, indexName).not.toContain(".catch(");
    }
  });

  it("gates the whole step on migration capacity first", () => {
    // Four index builds on a multi-gigabyte relation is a heavy step, and the
    // capacity gate must run before any of them.
    const capacity = MIGRATIONS.indexOf(
      'label: "meta_entity_observation_receipt_identity"',
    );
    const firstBuild = MIGRATIONS.search(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_entity_state_history_manifest_delta/,
    );
    expect(capacity).toBeGreaterThan(-1);
    expect(capacity).toBeLessThan(firstBuild);
  });
});

describe("the prepared D086 schema stays semantically aligned", () => {
  it("declares the same delta key as the live migration", () => {
    const prepared = readFileSync("lib/meta/budget-readiness-retention.ts", "utf8");
    /*
      The prepared list is applied to an EMPTY schema, where CONCURRENTLY is
      unnecessary and forbidden inside the surrounding transaction — so the
      statements differ deliberately. What must NOT differ is the key, which is
      what the catalog gate validates and what the query depends on.
    */
    for (const fragment of [
      "business_id, provider_account_id, entity_type, run_completeness",
      "entity_id, captured_at DESC, created_at DESC, id DESC",
    ]) {
      expect(prepared, fragment).toContain(fragment);
    }
  });
});
