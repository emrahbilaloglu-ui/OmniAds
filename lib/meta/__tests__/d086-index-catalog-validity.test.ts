/**
 * AN INDEX THAT EXISTS IS NOT AN INDEX POSTGRESQL WILL USE.
 *
 * ── ROUND 18, ITEMS C10 AND C11 ─────────────────────────────────────────────
 * `classifyIndexCatalog` read `pg_indexes`, which reports EXISTENCE. An
 * interrupted `CREATE INDEX CONCURRENTLY` leaves a row there that is named
 * correctly, carries the right definition, and is INVALID — PostgreSQL refuses
 * to use it — so the D086 readiness gate passed on a database whose access
 * paths were dead.
 *
 * The catalogue now joins `pg_index` and requires `indisvalid`, `indisready`
 * and `indislive`, and a present-but-unusable index is reported as UNUSABLE
 * with the failing flags rather than as missing (which would send an operator
 * to create an index that already exists).
 */
import { describe, expect, it } from "vitest";

import {
  D086_INDEX_CATALOG_SQL,
  D086_REQUIRED_INDEXES,
  classifyIndexCatalog,
} from "@/lib/meta/budget-readiness-retention";

/** Every required index, healthy, with a definition that satisfies its fragments. */
function healthyCatalog() {
  return D086_REQUIRED_INDEXES.map((required) => ({
    indexname: required.indexName,
    /*
      Built to contain EVERY required fragment verbatim, so these cases test the
      validity flags rather than accidentally testing definition matching.
    */
    indexdef: `CREATE INDEX ${required.indexName} ON public.t USING btree (${required.mustContain.join(
      ", ",
    )})`,
    indisvalid: true,
    indisready: true,
    indislive: true,
  }));
}

describe("the D086 index catalogue requires usability, not existence", () => {
  it("is satisfied by a healthy catalogue", () => {
    // The control: without it every negative below could pass on a validator
    // that simply never says yes.
    const verdict = classifyIndexCatalog(healthyCatalog());
    expect(verdict.satisfied).toBe(true);
    expect(verdict.missing).toEqual([]);
    expect(verdict.unusable).toEqual([]);
  });

  it.each(["indisvalid", "indisready", "indislive"] as const)(
    "reports a present index as UNUSABLE when %s is false",
    (flag) => {
      const rows = healthyCatalog().map((row, index) =>
        index === 0 ? { ...row, [flag]: false } : row,
      );
      const verdict = classifyIndexCatalog(rows);
      expect(verdict.satisfied).toBe(false);
      // UNUSABLE, not MISSING: the index is there, it just cannot be used.
      expect(verdict.missing).toEqual([]);
      expect(verdict.unusable.join("|")).toContain(flag);
      expect(verdict.unusable.join("|")).toContain(
        D086_REQUIRED_INDEXES[0]!.indexName,
      );
    },
  );

  it("does NOT assume absent flags are true", () => {
    /*
      A caller that cannot supply the flags has not proven the index is usable.
      Defaulting them to true is how the old `pg_indexes` behaviour would creep
      back in through a caller that forgot to select them.
    */
    const rows = healthyCatalog().map(({ indexname, indexdef }) => ({
      indexname,
      indexdef,
    }));
    const verdict = classifyIndexCatalog(rows);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.unusable.length).toBe(D086_REQUIRED_INDEXES.length);
  });

  it("still reports a genuinely absent index as MISSING", () => {
    const verdict = classifyIndexCatalog(healthyCatalog().slice(1));
    expect(verdict.missing).toEqual([D086_REQUIRED_INDEXES[0]!.indexName]);
  });

  it("still reports a wrong DEFINITION as unusable", () => {
    const rows = healthyCatalog().map((row, index) =>
      index === 0
        ? { ...row, indexdef: "CREATE INDEX x ON public.t USING btree (nothing)" }
        : row,
    );
    expect(classifyIndexCatalog(rows).satisfied).toBe(false);
  });

  it("selects the validity flags in the catalogue SQL itself", () => {
    // The verdict is only as good as what the query returns.
    for (const fragment of [
      "pg_index",
      "indisvalid",
      "indisready",
      "indislive",
      "pg_get_indexdef",
    ]) {
      expect(D086_INDEX_CATALOG_SQL, fragment).toContain(fragment);
    }
  });
});

describe("source and tests agree on the exact required index set", () => {
  it("requires the eight current read and dual-write indexes, by name", () => {
    /*
      ITEM C11. The set moved twice (Round 15 renamed three, Round 17 added the
      delta path). Pinning it by name here is what makes a future rename fail
      loudly in one place instead of silently in a readiness gate.
    */
    expect([...D086_REQUIRED_INDEXES].map((r) => r.indexName).sort()).toEqual(
      [
        "idx_meta_entity_observation_receipts_cohort_v2",
        "idx_meta_entity_observation_receipts_freshness_v2",
        "idx_meta_entity_observation_runs_d086_payload",
        "idx_meta_entity_state_history_d086_latest",
        "idx_meta_entity_state_history_manifest_delta",
        "idx_meta_entity_tombstones_d086_latest",
        "meta_entity_observation_receipts_attempt_occurrence",
        "meta_entity_observation_receipts_occurrence",
      ].sort(),
    );
  });

  it("keeps the rollback arbiter while historical ranked indexes are optional", () => {
    const names = D086_REQUIRED_INDEXES.map((r) => r.indexName);
    expect(names).toContain("meta_entity_observation_receipts_occurrence");
    expect(names).not.toContain("idx_meta_entity_observation_receipts_cohort");
    expect(names).not.toContain("idx_meta_entity_observation_receipts_freshness");
  });
});
