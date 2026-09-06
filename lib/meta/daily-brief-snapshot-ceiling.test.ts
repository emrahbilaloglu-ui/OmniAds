/**
 * The ceiling the brief asks for has to reach the SQL.
 *
 * `readLatestMetaDecisionSnapshot` accepts `startDate`/`endDate`, but its
 * `latest` CTE never used either: it took `MAX(snapshot_date)` over all time,
 * so a caller passing a historical range was handed today's decision snapshot
 * and could not tell. Asserting only that the daily brief passes a ceiling
 * would prove nothing about that — the argument has to change the query.
 *
 * These assertions read the emitted statement rather than the returned rows,
 * because the predicate is the defect: a fake connection returns whatever rows
 * it is told to regardless of what was asked for, so only the SQL itself can
 * say which snapshot dates were eligible.
 *
 * The uncapped case is asserted too, and deliberately: every other caller of
 * this reader (Decision Center, lane classification, the "last snapshot"
 * fact) passes a SELECTED METRIC RANGE and must keep resolving the newest
 * snapshot while a past range is on screen. The ceiling is opt-in, and this is
 * the test that says so.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
}));

import * as db from "@/lib/db";
import { readLatestMetaDecisionSnapshot } from "@/lib/meta/snapshot";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

const statements: string[] = [];

/**
 * The statement as the database would see it — bound values inlined.
 *
 * The date lives in a parameter, so a mock that only records the template
 * strings would show `snapshot_date <= ?` and pass whatever date was bound,
 * including none.
 */
function render(strings: TemplateStringsArray, values: unknown[]): string {
  return strings.reduce(
    (text, part, index) =>
      text + part + (index < values.length ? JSON.stringify(values[index]) : ""),
    "",
  );
}

/**
 * The body of the `latest` CTE — the half that decides WHICH snapshot is
 * served. The outer half only matches that resolved date, so a bound there
 * would prove nothing.
 */
function latestCte(statement: string): string {
  const body = /WITH latest AS \(([\s\S]*?)\n\s*\)\n/.exec(statement)?.[1];
  expect(body, "the decision read no longer resolves a `latest` snapshot date")
    .toBeTruthy();
  return body!;
}

async function decisionStatement(input: {
  snapshotDateCeiling?: string | null;
}): Promise<string> {
  statements.length = 0;
  await readLatestMetaDecisionSnapshot({
    businessId: BUSINESS,
    startDate: "2026-08-30",
    endDate: "2026-09-01",
    providerAccountId: "act_1",
    ...input,
  });
  const statement = statements.find((text) => text.includes("WITH latest AS"));
  expect(statement, "the decision snapshot was never read").toBeTruthy();
  return statement!;
}

beforeEach(() => {
  vi.clearAllMocks();
  statements.length = 0;
  const tag = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push(render(strings, values));
    // No rows: the read returns null right after this query, so nothing
    // downstream of it has to be stubbed for these assertions.
    return Promise.resolve([]);
  }) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn(async () => []) as never;
  vi.mocked(db.getDb).mockReturnValue(tag);
});

describe("the as-of ceiling reaches the snapshot the read resolves", () => {
  it("excludes snapshots newer than the requested day", async () => {
    const cte = latestCte(
      await decisionStatement({ snapshotDateCeiling: "2026-09-01" }),
    );

    // Without this the CTE is MAX(snapshot_date) over the whole table, and a
    // brief for 2026-09-01 served the decisions written this morning.
    expect(cte).toContain("snapshot_date <=");
    expect(cte).toContain('"2026-09-01"');
  });

  it("leaves the read at the newest snapshot when no ceiling is asked for", async () => {
    const cte = latestCte(await decisionStatement({}));

    expect(cte).toContain("MAX(snapshot_date)");
    // The range-picker callers pass dates that are metric context, not an
    // as-of. Turning their `endDate` into a bound would have served them a
    // stale snapshot whenever a past range was selected.
    expect(cte).not.toMatch(/snapshot_date\s*<=\s*"\d{4}-\d{2}-\d{2}"/);
  });
});
