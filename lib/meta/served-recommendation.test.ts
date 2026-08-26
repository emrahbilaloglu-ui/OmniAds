import { beforeEach, describe, expect, it, vi } from "vitest";

const getDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDb }));

const { readServedMetaRecommendation } = await import(
  "@/lib/meta/served-recommendation"
);

/**
 * The tagged-template client, captured.
 *
 * The query is a tagged template, so a test sees the literal fragments and the
 * interpolated values in order. That is enough to prove which columns the
 * predicate names and which values it binds — the point of these cases, because
 * a predicate against the wrong column is exactly the defect being guarded
 * against.
 */
function stubSql(answers: Array<unknown[] | Error>) {
  const calls: { text: string; values: unknown[] }[] = [];
  let index = 0;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    const answer = answers[Math.min(index++, answers.length - 1)] ?? [];
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  getDb.mockReturnValue(sql);
  return calls;
}

const BUSINESS = "biz_1";
const ACCOUNT = "act_1";
const REC = "rec_1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("acted, deferred and ignored need the CURRENT snapshot", () => {
  for (const action of ["acted", "deferred", "ignored"] as const) {
    it(`${action}: served when the rec is in this account's current snapshot`, async () => {
      stubSql([[{ snapshot_date: "2026-08-26" }]]);

      await expect(
        readServedMetaRecommendation({
          businessId: BUSINESS,
          recId: REC,
          action,
          providerAccountId: ACCOUNT,
        }),
      ).resolves.toEqual({ status: "served" });
    });

    /*
     * THE DEFECT THIS REPLACED. The previous rule accepted any row inside a
     * 30-day window, so an id served yesterday and absent from today's snapshot
     * still passed — while the mounted control is drawn from the LATEST
     * snapshot only and would never have offered it.
     */
    it(`${action}: refused when the rec is only in an OLDER snapshot`, async () => {
      // The query joins against MAX(snapshot_date); a rec that exists only on
      // an earlier date matches no row.
      stubSql([[]]);

      await expect(
        readServedMetaRecommendation({
          businessId: BUSINESS,
          recId: REC,
          action,
          providerAccountId: ACCOUNT,
        }),
      ).resolves.toEqual({ status: "not_served" });
    });

    it(`${action}: refused with no account, because "current" is per account`, async () => {
      const calls = stubSql([[{ snapshot_date: "2026-08-26" }]]);

      await expect(
        readServedMetaRecommendation({
          businessId: BUSINESS,
          recId: REC,
          action,
          providerAccountId: null,
        }),
      ).resolves.toEqual({ status: "not_served" });
      // And it does not fall back to a business-wide question.
      expect(calls).toEqual([]);
    });
  }

  it("binds the business, the account and the rec, and joins on the latest date", async () => {
    const calls = stubSql([[{ snapshot_date: "2026-08-26" }]]);

    await readServedMetaRecommendation({
      businessId: BUSINESS,
      recId: REC,
      action: "acted",
      providerAccountId: ACCOUNT,
    });

    const [call] = calls;
    expect(call!.text).toContain("FROM meta_decision_snapshots_daily");
    expect(call!.text).toContain("MAX(snapshot_date)");
    expect(call!.text).toContain("provider_account_id =");
    expect(call!.text).toContain("kind, 'recommendation'");
    expect(call!.values).toEqual([BUSINESS, ACCOUNT, BUSINESS, ACCOUNT, REC]);
  });

  /*
   * `scope_id` holds the BUSINESS id for account-level rows, so a predicate
   * against it would mean two different things by row level and would reject
   * every account-level recommendation. The account column is the only honest
   * instrument, and this pins that the wrong one is not used.
   */
  it("scopes on provider_account_id, never on scope_id", async () => {
    const calls = stubSql([[{ snapshot_date: "2026-08-26" }]]);

    await readServedMetaRecommendation({
      businessId: BUSINESS,
      recId: REC,
      action: "acted",
      providerAccountId: ACCOUNT,
    });

    expect(calls[0]!.text).not.toContain("scope_id");
  });
});

describe("undeferred needs an active prior deferral, not a served rec", () => {
  it("is served when the latest response is an unexpired deferral", async () => {
    stubSql([[{ "?column?": 1 }]]);

    await expect(
      readServedMetaRecommendation({
        businessId: BUSINESS,
        recId: REC,
        action: "undeferred",
        providerAccountId: ACCOUNT,
      }),
    ).resolves.toEqual({ status: "served" });
  });

  it("is refused when there is no prior deferral at all", async () => {
    stubSql([[]]);

    await expect(
      readServedMetaRecommendation({
        businessId: BUSINESS,
        recId: REC,
        action: "undeferred",
        providerAccountId: ACCOUNT,
      }),
    ).resolves.toEqual({ status: "not_served" });
  });

  /*
   * The rule is the LATEST response, not "a deferred row exists" — otherwise
   * defer -> undefer -> undefer passes forever. And expiry is preserved: a
   * deferral whose reappear_at has passed has already come back on its own, so
   * there is nothing left to lift. Both are expressed in the SQL, and this
   * pins the SQL rather than re-implementing it.
   */
  it("asks for the latest response, and excludes an expired deferral", async () => {
    const calls = stubSql([[]]);

    await readServedMetaRecommendation({
      businessId: BUSINESS,
      recId: REC,
      action: "undeferred",
      providerAccountId: ACCOUNT,
    });

    const text = calls[0]!.text;
    expect(text).toContain("ORDER BY timestamp DESC");
    expect(text).toContain("LIMIT 1");
    expect(text).toContain("latest.action = 'deferred'");
    expect(text).toContain("latest.reappear_at > NOW()");
    expect(text).toContain("FROM meta_decision_responses");
    // It does NOT consult the snapshot: an undeferral reaches backwards, and
    // requiring the current snapshot would refuse every legitimate one.
    expect(text).not.toContain("meta_decision_snapshots_daily");
  });

  it("does not need an account, because it is not a snapshot question", async () => {
    stubSql([[{ "?column?": 1 }]]);

    await expect(
      readServedMetaRecommendation({
        businessId: BUSINESS,
        recId: REC,
        action: "undeferred",
        providerAccountId: null,
      }),
    ).resolves.toEqual({ status: "served" });
  });
});

describe("an unreadable source is not an absent recommendation", () => {
  for (const action of ["acted", "undeferred"] as const) {
    it(`${action}: answers source_unavailable when the read throws`, async () => {
      stubSql([new Error('relation "meta_decision_snapshots_daily" does not exist')]);

      await expect(
        readServedMetaRecommendation({
          businessId: BUSINESS,
          recId: REC,
          action,
          providerAccountId: ACCOUNT,
        }),
      ).resolves.toEqual({ status: "source_unavailable" });
    });
  }

  for (const [label, input] of [
    ["no business", { businessId: "  ", recId: REC }],
    ["no id", { businessId: BUSINESS, recId: "   " }],
  ] as const) {
    it(`asks the source nothing when there is ${label}`, async () => {
      const calls = stubSql([[{ snapshot_date: "2026-08-26" }]]);

      await expect(
        readServedMetaRecommendation({
          ...input,
          action: "acted",
          providerAccountId: ACCOUNT,
        }),
      ).resolves.toEqual({ status: "not_served" });
      expect(calls).toEqual([]);
    });
  }
});
