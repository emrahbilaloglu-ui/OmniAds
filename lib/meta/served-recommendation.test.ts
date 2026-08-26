import { beforeEach, describe, expect, it, vi } from "vitest";

const getDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDb }));

const {
  readServedMetaRecommendation,
  SERVED_RECOMMENDATION_WINDOW_DAYS,
} = await import("@/lib/meta/served-recommendation");

/**
 * The tagged-template client, captured.
 *
 * The query is written as a tagged template, so what a test can see is the
 * literal fragments and the interpolated values in order. That is enough to
 * prove which columns the predicate names and which values it binds — which is
 * the whole point of these cases, because a predicate against the wrong column
 * is exactly the defect being guarded against.
 */
function stubSql(rows: unknown[] | Error) {
  const calls: { text: string; values: unknown[] }[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows);
  };
  getDb.mockReturnValue(sql);
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readServedMetaRecommendation", () => {
  it("answers served for an id the business's snapshot carries", async () => {
    stubSql([{ snapshot_date: "2026-05-06" }]);

    await expect(
      readServedMetaRecommendation({ businessId: "biz_1", recId: "rec_1" }),
    ).resolves.toEqual({ status: "served", snapshotDate: "2026-05-06" });
  });

  it("answers not_served when the source answered and had no such row", async () => {
    stubSql([]);

    await expect(
      readServedMetaRecommendation({ businessId: "biz_1", recId: "rec_invented" }),
    ).resolves.toEqual({ status: "not_served" });
  });

  /*
   * The difference this whole module exists for. A source that could not be
   * READ is not a recommendation that does not EXIST: answering "not served"
   * would tell the operator their recommendation is gone because the database
   * was unreadable, and answering "served" would be fail-open at a write
   * boundary.
   */
  it("answers source_unavailable when the read throws, never not_served", async () => {
    stubSql(new Error("relation \"meta_decision_snapshots_daily\" does not exist"));

    await expect(
      readServedMetaRecommendation({ businessId: "biz_1", recId: "rec_1" }),
    ).resolves.toEqual({ status: "source_unavailable" });
  });

  it("scopes to the business, the kind and the window, and binds the id", async () => {
    const calls = stubSql([{ snapshot_date: "2026-05-06" }]);

    await readServedMetaRecommendation({ businessId: "biz_1", recId: "rec_1" });

    const [call] = calls;
    expect(call).toBeDefined();
    expect(call!.text).toContain("FROM meta_decision_snapshots_daily");
    expect(call!.text).toContain("business_id =");
    expect(call!.text).toContain("rec_id =");
    expect(call!.text).toContain("kind = 'recommendation'");
    // The date bound is what makes this index-usable: the only index is
    // (business_id, snapshot_date) and rec_id is in none of them.
    expect(call!.text).toContain("snapshot_date >=");
    expect(call!.values).toEqual([
      "biz_1",
      SERVED_RECOMMENDATION_WINDOW_DAYS,
      "rec_1",
    ]);
  });

  /*
   * The table has no provider-account column, and for scope_type='account'
   * rows `scope_id` is the BUSINESS id. A predicate against `scope_id` would
   * therefore mean two different things depending on the row's level and would
   * reject every account-level recommendation. The check must not pretend to
   * an account scope the schema cannot carry.
   */
  it("does not filter on scope_id, which is not an account scope", async () => {
    const calls = stubSql([{ snapshot_date: "2026-05-06" }]);

    await readServedMetaRecommendation({ businessId: "biz_1", recId: "rec_1" });

    expect(calls[0]!.text).not.toContain("scope_id");
    expect(calls[0]!.text).not.toContain("provider_account_id");
  });

  it("clamps the window rather than trusting a caller's number", async () => {
    const calls = stubSql([]);

    await readServedMetaRecommendation({
      businessId: "biz_1",
      recId: "rec_1",
      windowDays: 100000,
    });
    await readServedMetaRecommendation({
      businessId: "biz_1",
      recId: "rec_1",
      windowDays: 0,
    });

    expect(calls[0]!.values[1]).toBe(365);
    expect(calls[1]!.values[1]).toBe(1);
  });

  for (const [label, input] of [
    ["no business", { businessId: "  ", recId: "rec_1" }],
    ["no id", { businessId: "biz_1", recId: "   " }],
  ] as const) {
    it(`asks the source nothing when there is ${label}`, async () => {
      const calls = stubSql([{ snapshot_date: "2026-05-06" }]);

      await expect(readServedMetaRecommendation(input)).resolves.toEqual({
        status: "not_served",
      });
      expect(calls).toEqual([]);
    });
  }
});
