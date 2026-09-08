/**
 * PRE-DEPLOY AUDIT — what makes two receipt writes the SAME occurrence.
 *
 * The canonical database-seams shell failed here, on its four-concurrent-runs
 * case, with:
 *
 *   Observation receipt collision with a DIFFERENT occurrence:
 *   observed_at 2026-09-03T12:26:01.434Z != 2026-09-03T12:26:01.433Z
 *
 * One millisecond. The guard was comparing `observed_at` — the clock of the
 * WRITE ATTEMPT — as though it identified the occurrence. It does not: the
 * database says an occurrence is
 * `(partition_id, entity_type, endpoint, captured_at)`, and that is the key
 * the guard's own lookup uses. So two attempts at one occurrence, a
 * millisecond apart, were refused as a collision between different ones. That
 * is the ordinary shape of a retry storm, and it was fatal.
 *
 * This pins the corrected rule against the SCHEMA rather than against the
 * code's current text, so the two cannot drift: whatever the unique index
 * says identifies an occurrence is what the guard is allowed to treat as
 * identity, and the write-attempt clocks stay out of it.
 *
 * ── ROUND 16 ────────────────────────────────────────────────────────────────
 * The identity GREW in Round 15 and this file still described the four-column
 * version. The partition row is reused across retries, so two DISTINCT sync
 * attempts capturing at the same millisecond collided on the old key and
 * `ON CONFLICT DO NOTHING` silently kept whichever committed first — possibly
 * the attempt whose config-history apply then failed. `sync_run_id` is now part
 * of the occurrence, with NULL collapsed to a sentinel so legacy retries keep
 * coalescing instead of appending under NULL-distinct semantics.
 *
 * The rule this file enforces is unchanged: the guard may treat as identity
 * exactly what the unique index names, and no more.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync("lib/meta/entity-state-history.ts", "utf8");
const MIGRATIONS = readFileSync("lib/migrations.ts", "utf8");

/** The guard: from its lookup down to the throw. */
const GUARD = SOURCE.slice(
  SOURCE.indexOf("FROM meta_entity_observation_receipts"),
  SOURCE.indexOf("Observation receipt collision with a DIFFERENT occurrence"),
);
/*
  Whitespace-collapsed. Several `compare(...)` calls and the explanatory
  comment wrap across lines, so a raw substring match would assert about the
  formatter rather than about the code.
*/
const FLAT = GUARD.replace(/\s+/g, " ");

describe("observation receipt — the occurrence key is the database's", () => {
  it("the unique index defines the occurrence, and now names the ATTEMPT too", () => {
    // ROUND 17: the build is CONCURRENT, so the CREATE is located by its own
    // statement rather than by the first mention of the name (which is now the
    // shared key constant).
    const at = MIGRATIONS.indexOf(
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS meta_entity_observation_receipts_attempt_occurrence",
    );
    expect(at).toBeGreaterThan(-1);
    const index = MIGRATIONS.slice(at, at + 400);
    expect(index).toContain("partition_id, entity_type, endpoint, captured_at");
    expect(index).toContain("COALESCE(sync_run_id");
    // `observed_at` is NOT identity. Stated here so the assertion below has a
    // reason rather than a preference.
    expect(index).not.toContain("observed_at");
  });

  it("the OLD four-column identity is dropped, not kept alongside", () => {
    /*
      Accepting either key would pass on a database where the attempt-scoped
      uniqueness was never created — exactly the state in which two attempts
      silently collapse into one receipt.
    */
    // ROUND 17: dropped CONCURRENTLY, like every other index touched on these
    // relations.
    const drop = MIGRATIONS.indexOf(
      "DROP INDEX CONCURRENTLY IF EXISTS meta_entity_observation_receipts_occurrence",
    );
    expect(drop).toBeGreaterThan(-1);
    /*
      And the drop comes after the replacement has been PROVEN VALID, not merely
      after it was requested: `buildIndexContractQuery` raises on an invalid or
      missing index and is unswallowed, so a failed build aborts the ordered
      step before this line is reached.
    */
    const proven = MIGRATIONS.indexOf(
      'buildIndexContractQuery({\n                indexName: "meta_entity_observation_receipts_attempt_occurrence"',
    );
    expect(proven).toBeGreaterThan(-1);
    expect(proven).toBeLessThan(drop);
  });

  it("the guard looks the row up by exactly that key", () => {
    for (const column of ["partition_id", "entity_type", "endpoint", "captured_at"]) {
      expect(GUARD, column).toContain(`${column} = `);
    }
    // The attempt is part of the lookup too: omitting it compared this attempt
    // against a DIFFERENT attempt's row and reported ordinary differences as a
    // contradiction.
    expect(FLAT).toContain("COALESCE(sync_run_id");
  });
});

describe("observation receipt — what the guard may and may not call a difference", () => {
  it("still compares every fact the receipt asserts about the occurrence", () => {
    /*
      The fix must not become "stop checking". These are the fields where a
      real second occurrence, or a corrupted write, actually shows up.
    */
    for (const field of [
      "run_id",
      "capture_status",
      "provider_row_count",
      "page_count",
      "source_snapshot_id",
      "source_snapshot_ref_id",
      "error_json",
    ]) {
      const inline = FLAT.includes(`compare("${field}"`);
      const wrapped = FLAT.includes(`compare( "${field}"`);
      expect(inline || wrapped, field).toBe(true);
    }
  });

  it("does NOT compare the write-attempt clock", () => {
    // The defect, pinned. A `compare("observed_at"` here makes a 1 ms retry
    // gap fatal again.
    expect(FLAT).not.toContain('compare("observed_at"');
    expect(FLAT).not.toContain('compare( "observed_at"');
  });

  it("does NOT compare run_reused, which describes the write and not the truth", () => {
    // The precedent this fix follows, asserted so the two stay consistent.
    expect(FLAT).not.toContain('compare("run_reused"');
    expect(FLAT).not.toContain('compare( "run_reused"');
  });

  it("states the reason in the source, so the exclusion is not mistaken for an oversight", () => {
    expect(FLAT).toContain("deliberately NOT compared");
    expect(FLAT).toContain("partition_id, entity_type, endpoint, captured_at");
    expect(FLAT).toContain("WRITE ATTEMPT");
  });

  it("keeps captured_at as identity — it is provider truth, not our clock", () => {
    /*
      The distinction the whole fix rests on. `captured_at` is in the unique
      index, so a different capture time is a different occurrence and never
      reaches this guard; `observed_at` is not, so it cannot be one.
    */
    expect(FLAT).toContain("captured_at = ");
    expect(FLAT).not.toContain('compare("captured_at"');
    expect(FLAT).not.toContain('compare( "captured_at"');
  });
});
