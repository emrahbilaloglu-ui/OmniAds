import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every `business_id` predicate in the History journal must agree on a type.
 *
 * The journal is one query with many UNION branches, so `$1` gets a single
 * type across all of them: whatever the first branch pinned it to, which is
 * `text`. A branch on a table whose `business_id` is UUID must therefore cast,
 * or Postgres refuses the *entire* query with "operator does not exist: uuid =
 * text".
 *
 * That is what makes this worth a test rather than a fix. One uncast branch
 * does not degrade one source — it takes the whole History surface down, every
 * source with it, and the failure only shows up against a real database.
 */
const readModel = readFileSync("lib/meta/history-read-model.ts", "utf8");
const migrations = readFileSync("lib/migrations.ts", "utf8");

/** The declared type of a column, read from the table's CREATE TABLE. */
function declaredColumnType(table: string, column: string): string | null {
  const start = migrations.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
  if (start < 0) return null;
  const body = migrations.slice(start, start + 4000);
  const match = new RegExp(`^\\s*${column}\\s+(\\w+)`, "m").exec(body);
  return match ? match[1].toUpperCase() : null;
}

describe("the History journal binds business_id consistently", () => {
  it("casts every UUID business_id compared against the text parameter", () => {
    // `FROM <table> <alias>` … `WHERE <alias>.business_id = $1`
    const branches = [
      ...readModel.matchAll(
        /FROM\s+([a-z0-9_]+)\s+([a-z0-9_]+)\b[\s\S]{0,600}?WHERE\s+\2\.business_id(::text)?\s*=\s*\$1/g,
      ),
    ];

    expect(
      branches.length,
      "no business_id branches found; the scan pattern has drifted from the SQL",
    ).toBeGreaterThan(2);

    const uncast: string[] = [];
    for (const [, table, , cast] of branches) {
      const type = declaredColumnType(table, "business_id");
      if (type === "UUID" && !cast) uncast.push(table);
    }

    expect(
      uncast,
      `these tables compare a UUID business_id to the text $1 with no cast, which fails the whole journal query: ${uncast.join(", ")}`,
    ).toEqual([]);
  });

  it("knows the table that actually broke, so this test cannot pass vacuously", () => {
    // A regression check is worthless if its scan silently matches nothing.
    expect(declaredColumnType("meta_ads_action_mutation_attempt_events", "business_id")).toBe("UUID");
    expect(readModel).toContain("WHERE attempt.business_id::text = $1");
  });

  it("leaves text columns uncast rather than casting everything blindly", () => {
    // decision_workflow_events.business_id is TEXT; a cast there would be
    // noise, and casting everywhere hides which columns are actually uuid.
    expect(declaredColumnType("decision_workflow_events", "business_id")).toBe("TEXT");
    expect(readModel).toContain("WHERE workflow.business_id = $1");
  });
});
