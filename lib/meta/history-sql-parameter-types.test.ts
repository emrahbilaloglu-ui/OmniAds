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

/**
 * Resolve every `<alias>.business_id = $1` predicate to the table it filters.
 *
 * Two earlier shapes of this scan were wrong in the same way -- they checked a
 * subset they never named. The first matched `FROM <table> <alias>` followed
 * within 600 characters by the predicate, and found ten of eighteen. The second
 * split the SQL on `UNION ALL`, which breaks on the branches that contain a
 * LATERAL subquery with its own UNION ALL, separating a FROM from its WHERE.
 *
 * So no splitting: each predicate's alias is resolved against the aliases
 * declared anywhere in the file, and the count is asserted against the raw
 * number of predicates. A scan that silently checks fewer things than exist is
 * not a regression test.
 */
function aliasTables(sql: string): Map<string, string> {
  const byAlias = new Map<string, string>();
  for (const [, table, alias] of sql.matchAll(
    /\bFROM\s+([a-z0-9_]+)\s+([a-z0-9_]+)\b/gi,
  )) {
    if (!/^(as|on|where|inner|left|join|union|order|group|limit)$/i.test(alias)) {
      byAlias.set(alias, table);
    }
  }

  // A branch may now read from a CTE rather than the table itself — the
  // configuration branches select from a window CTE that resolves each row's
  // predecessor in one pass. A CTE has no CREATE TABLE, so follow it to the
  // table it reads from; otherwise the scan reports "no DDL found" and stops
  // checking the very predicates it exists to check.
  const cteSources = new Map<string, string>();
  for (const [, cte, table] of sql.matchAll(
    /\b([a-z0-9_]+)\s+AS\s*\(\s*SELECT[\s\S]*?\bFROM\s+([a-z0-9_]+)\b/gi,
  )) {
    cteSources.set(cte, table);
  }
  for (const [alias, table] of byAlias) {
    let resolved = table;
    for (let hop = 0; hop < 4 && cteSources.has(resolved); hop += 1) {
      resolved = cteSources.get(resolved) as string;
    }
    byAlias.set(alias, resolved);
  }
  return byAlias;
}

interface JournalPredicate {
  alias: string;
  table: string | null;
  cast: boolean;
}

function journalPredicates(sql: string): JournalPredicate[] {
  const byAlias = aliasTables(sql);
  return [
    ...sql.matchAll(/\b([a-z0-9_]+)\.business_id(::text)?\s*=\s*\$1/g),
  ].map(([, alias, cast]) => ({
    alias,
    table: byAlias.get(alias) ?? null,
    cast: Boolean(cast),
  }));
}

describe("the History journal binds business_id consistently", () => {
  it("casts every UUID business_id compared against the text parameter", () => {
    const predicates = journalPredicates(readModel);
    const rawCount = (
      readModel.match(/\b[a-z0-9_]+\.business_id(::text)?\s*=\s*\$1/g) ?? []
    ).length;

    expect(predicates.length).toBe(rawCount);
    expect(rawCount, "the scan matched nothing").toBeGreaterThan(5);

    const unresolved = predicates
      .filter((predicate) => predicate.table === null)
      .map((predicate) => predicate.alias);
    expect(
      unresolved,
      `could not resolve the table behind: ${unresolved.join(", ")} — those predicates went unchecked`,
    ).toEqual([]);

    const unknownDdl: string[] = [];
    const uncast: string[] = [];
    for (const predicate of predicates) {
      const type = declaredColumnType(predicate.table as string, "business_id");
      // No DDL found is not a pass. Unchecked is how the original defect lived.
      if (type === null) {
        unknownDdl.push(predicate.table as string);
        continue;
      }
      if (type === "UUID" && !predicate.cast) uncast.push(predicate.table as string);
    }

    expect(
      unknownDdl,
      `no CREATE TABLE found for: ${unknownDdl.join(", ")}`,
    ).toEqual([]);
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
