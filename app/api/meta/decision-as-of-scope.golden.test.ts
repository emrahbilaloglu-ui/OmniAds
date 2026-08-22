import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Golden and invariant coverage for ADR D070.
 *
 * Written before the predicate changes, per the plan's rule that resolver
 * semantics changes carry executable coverage first. These assert the contract
 * the resolver must satisfy, independent of how it is phrased in SQL.
 */

const ROUTE_PATH = "app/api/meta/decisions-workspace/route.ts";
const MIGRATIONS_PATH = "lib/migrations.ts";

const route = readFileSync(ROUTE_PATH, "utf8");
const migrations = readFileSync(MIGRATIONS_PATH, "utf8");

/** Columns declared by a table's CREATE TABLE block. */
function declaredColumns(table: string): Set<string> {
  const start = migrations.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start === -1) throw new Error(`${table} has no CREATE TABLE in migrations`);
  const body = migrations.slice(start, migrations.indexOf(")`", start));
  const names = new Set<string>();
  for (const line of body.split("\n").slice(1)) {
    const match = line.match(/^\s{6,}([a-z_]+)\s+[A-Z]/);
    if (match) names.add(match[1]);
  }
  // Columns added later by ALTER statements count as declared too.
  for (const alter of migrations.matchAll(
    new RegExp(`ALTER TABLE (?:IF EXISTS )?${table}[\\s\\S]{0,400}?ADD COLUMN IF NOT EXISTS ([a-z_]+)`, "g"),
  )) {
    names.add(alter[1]);
  }
  return names;
}

/** The resolver's SQL body, isolated from the rest of the route. */
function resolverSql(): string {
  const start = route.indexOf("async function resolveWorkspaceEndDate");
  expect(start).toBeGreaterThan(-1);
  const end = route.indexOf("\nasync function", start + 1);
  return route.slice(start, end === -1 ? undefined : end);
}

describe("D070 invariant: the resolver only filters on columns that exist", () => {
  it("does not filter engine_v3_decision_snapshots_daily on provider_account_id", () => {
    const sql = resolverSql();
    const declared = declaredColumns("engine_v3_decision_snapshots_daily");
    expect(declared.has("provider_account_id")).toBe(false);

    // Isolate the statements that read this table and assert none of them
    // constrain it by a column it does not have.
    for (const fragment of sql.split("FROM engine_v3_decision_snapshots_daily").slice(1)) {
      const predicate = fragment.slice(0, fragment.indexOf(")") + 1);
      expect(
        predicate.includes("provider_account_id ="),
        "engine_v3_decision_snapshots_daily filtered on a column it does not declare",
      ).toBe(false);
    }
  });

  it("expects the native snapshot table to be absent on this branch, so the second lookup carries the answer", () => {
    // engine_v3_ad_decision_snapshots_daily ships with the unmerged
    // native-authority work (G0-F1). Its absence makes the first lookup raise
    // 42P01, which C3 classifies as an expected capability gate — so the
    // rescoped second lookup is what actually resolves the date here.
    expect(migrations).not.toContain(
      "CREATE TABLE IF NOT EXISTS engine_v3_ad_decision_snapshots_daily (",
    );
    const sql = resolverSql();
    const secondLookup = sql.slice(sql.lastIndexOf("SELECT MAX(snapshot.as_of_date)::text"));
    expect(secondLookup).toContain("creative_account_scope");
    expect(secondLookup).not.toContain("provider_account_id = $2\n");
  });

  it("scopes the snapshot table through creative account keys, as history does", () => {
    const sql = resolverSql();
    expect(sql).toContain("creative_account_scope");
    // The single-account guard must survive: a creative seen under two accounts
    // is excluded rather than attributed to one of them.
    expect(sql).toContain("COUNT(DISTINCT provider_account_id) = 1");
  });
});

describe("D070 golden: the resolver's contract", () => {
  it("still honours an explicit end date without querying at all", () => {
    const sql = resolverSql();
    expect(sql).toContain("if (input.explicitEndDate?.trim()) return input.explicitEndDate.trim();");
  });

  it("still falls back to the previous completed UTC day when nothing is found", () => {
    expect(resolverSql().trimEnd().endsWith("return previousUtcDate();\n}")).toBe(true);
  });

  it("still returns only an ISO date", () => {
    expect(resolverSql()).toContain("/^\\d{4}-\\d{2}-\\d{2}$/.test(latest)");
  });

  it("keeps reporting why a lookup failed rather than swallowing it", () => {
    const sql = resolverSql();
    expect(sql).not.toMatch(/\}\s*catch\s*\{/);
    expect(sql).toContain("reportDecisionDateFallback");
  });
});

describe("D070 scope: what this decision does not touch", () => {
  it("does not alter date-range replay semantics", () => {
    const contract = readFileSync("lib/meta/decisions-workspace-contract.ts", "utf8");
    expect(contract).toContain("metricsRangeAffectsDecisionSnapshot: false");
  });

  it("has a ratified ADR on disk stating the change and its rollback", () => {
    const adr = readFileSync(
      "docs/creative-decision-center/ADR-D070-DECISION-AS-OF-SCOPE.md",
      "utf8",
    );
    // Was `Status:** Proposed` while ratification was outstanding. WP0 of the
    // Meta market-ready plan closed the ADR's own "Required evidence" item 5 by
    // writing the decision into the authority record, so the assertion now
    // pins the ratified state — flipping this file back to Proposed while the
    // log still carries D070 would leave the two disagreeing again.
    expect(adr).toContain("Status:** **Accepted**");
    expect(adr).toContain("Rollback");
    expect(adr).toContain("creative_account_scope");
  });

  it("is ratified in the authority record, not only in the ADR file", () => {
    // The ADR file is the rationale; `DECISION_LOG.md` is the authority. An ADR
    // that calls itself Accepted with no log entry is the exact failure this
    // pair of assertions exists to catch — the master plan's §17 prohibition on
    // treating an unratified decision as resolved.
    const log = readFileSync(
      "docs/creative-decision-center/DECISION_LOG.md",
      "utf8",
    );
    expect(log).toContain("## D070 -");
    expect(log).toContain("creative_account_scope");
  });
});
