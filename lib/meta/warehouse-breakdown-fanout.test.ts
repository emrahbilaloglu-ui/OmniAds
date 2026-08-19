/**
 * Two laws that live in SQL TEXT, and one that lives in arithmetic.
 *
 * `lib/meta/warehouse.ts` builds the breakdown-coverage CTE three times: once
 * as a tagged template with the truth-lifecycle columns, once through
 * `sql.query` with positional parameters, and once as a tagged template
 * without them. A tagged-template interpolation binds a PARAMETER, not a join
 * source, so two of those three copies must carry the scope→type relation
 * written out literally. Three hand-written copies of one rule is exactly the
 * shape that had `breakdown:age,gender` mapped to a single type in all three
 * places for as long as the fold existed — so the copies are pinned here rather
 * than trusted.
 *
 * This file reads source text on purpose. The queries need a real PostgreSQL to
 * execute (see `lib/meta/breakdown-dimension-reach.db.test.ts`), but drift
 * BETWEEN the copies is a property of the file, and a source read catches it
 * without a cluster.
 *
 * No provider client and no database is imported here. Real provider writes
 * performed: zero.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { deriveMetaFrequencyFromReach } from "@/lib/meta/warehouse-types";

const WAREHOUSE_SOURCE = fs.readFileSync(
  path.join(process.cwd(), "lib", "meta", "warehouse.ts"),
  "utf8",
);

function occurrences(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

describe("breakdown checkpoint scope fan-out", () => {
  it("no longer collapses the age,gender scope onto a single type", () => {
    // The exact expression that made gender coverage structurally invisible.
    expect(occurrences(WAREHOUSE_SOURCE, "WHEN 'breakdown:age,gender' THEN 'age'")).toBe(0);
    expect(occurrences(WAREHOUSE_SOURCE, "CASE checkpoint.checkpoint_scope")).toBe(0);
  });

  it("joins the scope→type relation in all three coverage queries", () => {
    expect(
      occurrences(
        WAREHOUSE_SOURCE,
        "AS checkpoint_scope_type(checkpoint_scope, breakdown_type)",
      ),
    ).toBe(3);
    expect(
      occurrences(
        WAREHOUSE_SOURCE,
        "checkpoint_scope_type.breakdown_type AS breakdown_type",
      ),
    ).toBe(3);
  });

  it("maps age,gender to BOTH dimensions and leaves the others alone", () => {
    // The literal copies (tagged templates) must agree with each other. The
    // parameterised copy is generated from the constant and is checked by the
    // pair count below.
    expect(occurrences(WAREHOUSE_SOURCE, "('breakdown:age,gender', 'age')")).toBe(2);
    expect(occurrences(WAREHOUSE_SOURCE, "('breakdown:age,gender', 'gender')")).toBe(2);
    expect(occurrences(WAREHOUSE_SOURCE, "('breakdown:country', 'country')")).toBe(2);
    expect(
      occurrences(
        WAREHOUSE_SOURCE,
        "('breakdown:publisher_platform,platform_position,impression_device', 'placement')",
      ),
    ).toBe(2);

    // ...and the constant the third copy is generated from carries the same
    // four pairs, `age,gender` twice and every other scope once.
    const pairsBlock = WAREHOUSE_SOURCE.slice(
      WAREHOUSE_SOURCE.indexOf("const META_BREAKDOWN_CHECKPOINT_SCOPE_TYPE_PAIRS"),
      WAREHOUSE_SOURCE.indexOf("] as const satisfies ReadonlyArray<{\n  checkpointScope:"),
    );
    expect(occurrences(pairsBlock, 'breakdownType: "age"')).toBe(1);
    expect(occurrences(pairsBlock, 'breakdownType: "gender"')).toBe(1);
    expect(occurrences(pairsBlock, 'breakdownType: "country"')).toBe(1);
    expect(occurrences(pairsBlock, 'breakdownType: "placement"')).toBe(1);
    expect(occurrences(pairsBlock, '"breakdown:age,gender"')).toBe(2);
  });

  it("counts coverage over the three expected types only, so gender cannot mask a gap", () => {
    // WITHOUT this filter, a day holding age + gender + placement counts three
    // DISTINCT types and passes the >= 3 gate while `country` is missing
    // entirely — adding a dimension would have loosened a completeness gate.
    expect(occurrences(WAREHOUSE_SOURCE, "WHERE breakdown_type IS NOT NULL")).toBe(0);
    expect(
      occurrences(WAREHOUSE_SOURCE, "WHERE breakdown_type IN ('age', 'country', 'placement')"),
    ).toBe(2);
    expect(
      occurrences(
        WAREHOUSE_SOURCE,
        "WHERE breakdown_type IN (${META_EXPECTED_BREAKDOWN_TYPES_SQL_LIST})",
      ),
    ).toBe(1);

    // The generated list must spell the same three types as the literal copies.
    const expectedBlock = WAREHOUSE_SOURCE.slice(
      WAREHOUSE_SOURCE.indexOf("const META_EXPECTED_FINALIZED_BREAKDOWN_TYPES"),
      WAREHOUSE_SOURCE.indexOf("const META_BREAKDOWN_CHECKPOINT_SCOPES"),
    );
    expect(expectedBlock).toContain('"age"');
    expect(expectedBlock).toContain('"country"');
    expect(expectedBlock).toContain('"placement"');
    expect(expectedBlock).not.toContain('"gender"');
  });
});

describe("deriveMetaFrequencyFromReach", () => {
  it("returns null for a reach that was never measured", () => {
    expect(deriveMetaFrequencyFromReach({ impressions: 500, reach: null })).toBeNull();
    expect(deriveMetaFrequencyFromReach({ impressions: 500, reach: undefined })).toBeNull();
  });

  it("returns null rather than Infinity for a measured zero", () => {
    // A measured zero is a real answer about reach and a nonsense divisor. The
    // wrong answers here are 0 (a fabricated "nobody saw it twice") and
    // Infinity (which serialises to null through JSON and arrives as a mystery).
    const frequency = deriveMetaFrequencyFromReach({ impressions: 500, reach: 0 });
    expect(frequency).toBeNull();
    expect(frequency).not.toBe(0);
  });

  it("divides impressions by reach and rounds to two places", () => {
    expect(deriveMetaFrequencyFromReach({ impressions: 160, reach: 80 })).toBe(2);
    expect(deriveMetaFrequencyFromReach({ impressions: 100, reach: 30 })).toBe(3.33);
  });

  it("refuses a non-finite input instead of propagating NaN", () => {
    expect(
      deriveMetaFrequencyFromReach({ impressions: Number.NaN, reach: 10 }),
    ).toBeNull();
    expect(
      deriveMetaFrequencyFromReach({ impressions: 10, reach: Number.POSITIVE_INFINITY }),
    ).toBeNull();
  });
});
