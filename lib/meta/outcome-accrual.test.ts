import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyKpiOutcome,
  META_OUTCOME_MIN_WINDOW_SPEND,
  metaOutcomeFingerprint,
  runMetaOutcomeAccrualForBusiness,
  runMetaOutcomeAccrualIfDue,
} from "@/lib/meta/outcome-accrual";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

vi.mock("@/lib/meta/decision-outcomes", () => ({
  appendMetaDecisionActionOutcomeLog: vi.fn(async () => "log_1"),
}));

vi.mock("@/lib/sync/active-businesses", () => ({
  getActiveBusinesses: vi.fn(async () => [{ id: "biz_1" }]),
}));

const db = await import("@/lib/db");
const readiness = await import("@/lib/db-schema-readiness");
const outcomes = await import("@/lib/meta/decision-outcomes");

describe("classifyKpiOutcome", () => {
  it("is inconclusive below the spend floor in either window", () => {
    expect(
      classifyKpiOutcome({
        spendBefore: META_OUTCOME_MIN_WINDOW_SPEND - 1,
        revenueBefore: 500,
        spendAfter: 500,
        revenueAfter: 500,
      }),
    ).toBe("inconclusive");
    expect(
      classifyKpiOutcome({
        spendBefore: 500,
        revenueBefore: 500,
        spendAfter: 0,
        revenueAfter: 0,
      }),
    ).toBe("inconclusive");
  });

  it("classifies the +-5% ROAS bands", () => {
    // before ROAS 2.0
    expect(
      classifyKpiOutcome({ spendBefore: 100, revenueBefore: 200, spendAfter: 100, revenueAfter: 211 }),
    ).toBe("improved");
    expect(
      classifyKpiOutcome({ spendBefore: 100, revenueBefore: 200, spendAfter: 100, revenueAfter: 189 }),
    ).toBe("regressed");
    expect(
      classifyKpiOutcome({ spendBefore: 100, revenueBefore: 200, spendAfter: 100, revenueAfter: 200 }),
    ).toBe("flat");
  });

  it("treats zero-revenue-before with real delivery honestly", () => {
    expect(
      classifyKpiOutcome({ spendBefore: 100, revenueBefore: 0, spendAfter: 100, revenueAfter: 50 }),
    ).toBe("improved");
    expect(
      classifyKpiOutcome({ spendBefore: 100, revenueBefore: 0, spendAfter: 100, revenueAfter: 0 }),
    ).toBe("flat");
  });
});

/** Every statement the module issued, so a predicate can be proven present. */
const issued: Array<{ text: string; values: unknown[] }> = [];

function makeSqlMock(input: {
  candidates?: Array<Record<string, unknown>>;
  kpiRows?: Array<Record<string, unknown>>;
  actedRows?: Array<Record<string, unknown>>;
  /** Answer the KPI read per requested account, for the collision cases. */
  kpiRowsByAccount?: Record<string, Array<Record<string, unknown>>>;
  actedRowsByAccount?: Record<string, Array<Record<string, unknown>>>;
}) {
  const tag = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    issued.push({ text, values });
    if (text.includes("FROM meta_decision_snapshots_daily")) {
      return Promise.resolve(input.candidates ?? []);
    }
    if (text.includes("FROM meta_decision_responses")) {
      if (input.actedRowsByAccount) {
        const account = values.find(
          (value) => typeof value === "string" && value.startsWith("act_"),
        ) as string | undefined;
        return Promise.resolve(input.actedRowsByAccount[account ?? ""] ?? []);
      }
      return Promise.resolve(input.actedRows ?? []);
    }
    return Promise.resolve([]);
  }) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn((text: string, values: unknown[] = []) => {
    issued.push({ text, values });
    if (text.includes("FROM meta_campaign_daily") || text.includes("FROM meta_adset_daily")) {
      if (input.kpiRowsByAccount) {
        const account = values.find(
          (value) => typeof value === "string" && value.startsWith("act_"),
        ) as string | undefined;
        return Promise.resolve(input.kpiRowsByAccount[account ?? ""] ?? []);
      }
      return Promise.resolve(input.kpiRows ?? []);
    }
    return Promise.resolve([]);
  }) as never;
  return tag;
}

describe("metaOutcomeFingerprint carries the physical account", () => {
  const base = {
    businessId: "biz_1",
    scopeType: "campaign",
    scopeId: "cmp_1",
    recType: "bid_efficiency",
    snapshotDate: "2026-06-29",
  };

  /*
   * The upgrade contract. A row written before snapshots carried a lineage must
   * keep the fingerprint it was written with, or the guard stops finding it and
   * every legacy snapshot accrues a second time.
   */
  it("is byte-identical to the pre-change form when there is no account", () => {
    const legacy = "meta_v1|biz_1|campaign|cmp_1|bid_efficiency|2026-06-29";
    expect(metaOutcomeFingerprint(base)).toBe(legacy);
    expect(metaOutcomeFingerprint({ ...base, providerAccountId: null })).toBe(legacy);
    expect(metaOutcomeFingerprint({ ...base, providerAccountId: "   " })).toBe(legacy);
  });

  /*
   * THE DEFECT THIS CLOSES. Two accounts holding the same scope, rec type and
   * date produced ONE fingerprint, so the NOT EXISTS guard let whichever
   * account accrued first suppress the other's outcome for good.
   */
  it("separates two accounts that share a scope, rec type and date", () => {
    const a = metaOutcomeFingerprint({ ...base, providerAccountId: "act_1" });
    const b = metaOutcomeFingerprint({ ...base, providerAccountId: "act_2" });
    expect(a).not.toBe(b);
    expect(a).toBe("meta_v1|biz_1|campaign|cmp_1|bid_efficiency|2026-06-29|act_1");
    // ...and neither collides with the legacy form.
    expect(a).not.toBe(metaOutcomeFingerprint(base));
  });
});

describe("runMetaOutcomeAccrualForBusiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issued.length = 0;
  });

  it("narrows every read to the candidate's own account", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        candidates: [
          {
            business_id: "biz_1",
            provider_account_id: "act_1",
            scope_type: "campaign",
            scope_id: "cmp_1",
            rec_type: "bid_efficiency",
            rec_id: "bid-cmp_1",
            decision_label: "tune",
            confidence_score: "0.82",
            snapshot_date: "2026-06-29",
          },
        ],
      }),
    );

    await runMetaOutcomeAccrualForBusiness("biz_1", new Date("2026-07-07T05:05:00.000Z"));

    // The candidate query selects and matches on the lineage, and its
    // idempotency guard is scoped by it rather than by the business alone.
    const candidateQuery = issued.find((entry) =>
      entry.text.includes("FROM meta_decision_snapshots_daily"),
    )!;
    expect(candidateQuery.text).toContain("snapshot.provider_account_id");
    expect(candidateQuery.text).toContain(
      "log.provider_account_id IS NOT DISTINCT FROM snapshot.provider_account_id",
    );

    // The KPI window is narrowed BEFORE the sums, not filtered after.
    const kpiQuery = issued.find((entry) =>
      entry.text.includes("FROM meta_campaign_daily"),
    )!;
    expect(kpiQuery.text).toContain("provider_account_id = $7");
    expect(kpiQuery.values).toContain("act_1");

    // Both operator-response sources match the account DIRECTLY. Each persists
    // one, so neither is inferred from an entity or a rec id.
    const actedQuery = issued.find((entry) =>
      entry.text.includes("FROM meta_decision_responses"),
    )!;
    expect(actedQuery.text).toContain("FROM meta_ads_action_log");
    expect(
      actedQuery.text.match(/provider_account_id = \?/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(actedQuery.text).not.toContain("meta_ad_dimensions");
    expect(actedQuery.values).toContain("act_1");
  });

  /*
   * Two accounts, ONE campaign id, opposite KPI movement. A map keyed by scope
   * id alone pools them and hands both accounts the same verdict.
   */
  it("keeps two accounts' colliding scope ids apart", async () => {
    const candidate = (account: string) => ({
      business_id: "biz_1",
      provider_account_id: account,
      scope_type: "campaign",
      scope_id: "cmp_shared",
      rec_type: "bid_efficiency",
      rec_id: "rec_shared",
      decision_label: "tune",
      confidence_score: "0.8",
      snapshot_date: "2026-06-29",
    });
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        candidates: [candidate("act_1"), candidate("act_2")],
        kpiRowsByAccount: {
          act_1: [
            {
              scope_id: "cmp_shared",
              spend_before: 700,
              revenue_before: 700,
              spend_after: 700,
              revenue_after: 2100,
            },
          ],
          act_2: [
            {
              scope_id: "cmp_shared",
              spend_before: 700,
              revenue_before: 700,
              spend_after: 700,
              revenue_after: 140,
            },
          ],
        },
        actedRowsByAccount: { act_1: [{ rec_id: "rec_shared" }], act_2: [] },
      }),
    );

    const result = await runMetaOutcomeAccrualForBusiness(
      "biz_1",
      new Date("2026-07-07T05:05:00.000Z"),
    );
    expect(result).toMatchObject({ candidates: 2, written: 2 });

    const appended = vi
      .mocked(outcomes.appendMetaDecisionActionOutcomeLog)
      .mock.calls.map(([call]) => call);
    const byAccount = new Map(appended.map((call) => [call.providerAccountId, call]));

    expect(byAccount.get("act_1")?.outcomeStatus).toBe("improved");
    expect(byAccount.get("act_2")?.outcomeStatus).toBe("regressed");
    // Distinct fingerprints, or the second write would have been suppressed as
    // a duplicate of the first.
    expect(byAccount.get("act_1")?.recommendationFingerprint).not.toBe(
      byAccount.get("act_2")?.recommendationFingerprint,
    );
    // One account's operator response is not the other's.
    expect(byAccount.get("act_1")?.payloadJson).toMatchObject({
      operatorActed: true,
      providerAccountId: "act_1",
      accountAttribution: "exact",
    });
    expect(byAccount.get("act_2")?.payloadJson).toMatchObject({
      operatorActed: false,
      providerAccountId: "act_2",
    });
  });

  /*
   * A row that predates the lineage column keeps working and is NOT given an
   * account. Reading business-wide is what it always meant; inventing one would
   * put unattributable evidence inside a named account.
   */
  it("accrues a legacy candidate without inventing an account for it", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        candidates: [
          {
            business_id: "biz_1",
            provider_account_id: null,
            scope_type: "campaign",
            scope_id: "cmp_legacy",
            rec_type: "bid_efficiency",
            rec_id: "rec_legacy",
            decision_label: "tune",
            confidence_score: "0.8",
            snapshot_date: "2026-06-29",
          },
        ],
        kpiRows: [
          {
            scope_id: "cmp_legacy",
            spend_before: 700,
            revenue_before: 700,
            spend_after: 700,
            revenue_after: 700,
          },
        ],
      }),
    );

    await runMetaOutcomeAccrualForBusiness("biz_1", new Date("2026-07-07T05:05:00.000Z"));

    const appended = vi.mocked(outcomes.appendMetaDecisionActionOutcomeLog).mock.calls[0]![0];
    expect(appended.providerAccountId).toBeNull();
    expect(appended.recommendationFingerprint).toBe(
      "meta_v1|biz_1|campaign|cmp_legacy|bid_efficiency|2026-06-29",
    );
    expect(appended.payloadJson).toMatchObject({
      providerAccountId: null,
      accountAttribution: "unattributed_legacy",
    });
    // The reads stay business-wide for it, which is what it measured before.
    const kpiQuery = issued.find((entry) =>
      entry.text.includes("FROM meta_campaign_daily"),
    )!;
    expect(kpiQuery.values).toContain(null);
  });

  it("labels 8-day-old act recommendations with KPI movement and operator response", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        candidates: [
          {
            business_id: "biz_1",
            scope_type: "campaign",
            scope_id: "cmp_1",
            rec_type: "bid_efficiency",
            rec_id: "bid-cmp_1",
            decision_label: "tune",
            confidence_score: "0.82",
            snapshot_date: "2026-06-29",
          },
        ],
        kpiRows: [
          {
            scope_id: "cmp_1",
            spend_before: 700,
            revenue_before: 1400,
            spend_after: 700,
            revenue_after: 1600,
          },
        ],
        actedRows: [{ rec_id: "bid-cmp_1" }],
      }),
    );

    const result = await runMetaOutcomeAccrualForBusiness(
      "biz_1",
      new Date("2026-07-07T05:05:00.000Z"),
    );

    expect(result).toMatchObject({ candidates: 1, written: 1, snapshotDate: "2026-06-29" });
    expect(outcomes.appendMetaDecisionActionOutcomeLog).toHaveBeenCalledTimes(1);
    const appended = vi.mocked(outcomes.appendMetaDecisionActionOutcomeLog).mock.calls[0]![0];
    expect(appended.actionType).toBe("outcome");
    expect(appended.outcomeStatus).toBe("improved");
    expect(appended.recommendationFingerprint).toBe(
      metaOutcomeFingerprint({
        businessId: "biz_1",
        scopeType: "campaign",
        scopeId: "cmp_1",
        recType: "bid_efficiency",
        snapshotDate: "2026-06-29",
      }),
    );
    expect(appended.payloadJson).toMatchObject({
      rule: "auto_kpi_7d.v1",
      evidenceClass: "observational_pre_post",
      causalDesign: null,
      treatmentReceipt: null,
      operatorActed: true,
      confidenceScore: 0.82,
    });
  });

  it("writes inconclusive when the scope has no KPI rows", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        candidates: [
          {
            business_id: "biz_1",
            scope_type: "adset",
            scope_id: "adset_1",
            rec_type: "adset_cut_spend",
            rec_id: "adset_cut_spend-adset_1",
            decision_label: "cut",
            confidence_score: 0.75,
            snapshot_date: "2026-06-29",
          },
        ],
        kpiRows: [],
        actedRows: [],
      }),
    );

    await runMetaOutcomeAccrualForBusiness("biz_1", new Date("2026-07-07T05:05:00.000Z"));

    const appended = vi.mocked(outcomes.appendMetaDecisionActionOutcomeLog).mock.calls[0]![0];
    expect(appended.outcomeStatus).toBe("inconclusive");
    expect(appended.payloadJson).toMatchObject({ operatorActed: false });
  });

  it("writes nothing when there are no unlabeled candidates", async () => {
    vi.mocked(db.getDb).mockReturnValue(makeSqlMock({ candidates: [] }));

    const result = await runMetaOutcomeAccrualForBusiness(
      "biz_1",
      new Date("2026-07-07T05:05:00.000Z"),
    );

    expect(result.written).toBe(0);
    expect(outcomes.appendMetaDecisionActionOutcomeLog).not.toHaveBeenCalled();
  });
});

describe("runMetaOutcomeAccrualIfDue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-07-07T05:00:00.000Z",
    });
  });

  it("skips outside the 05:00 UTC slot", async () => {
    const result = await runMetaOutcomeAccrualIfDue(new Date("2026-07-07T03:10:00.000Z"));
    expect(result).toMatchObject({ skipped: true, reason: "not_due" });
  });

  it("skips when the schema is not ready", async () => {
    vi.mocked(readiness.getDbSchemaReadiness).mockResolvedValue({
      ready: false,
      missingTables: ["meta_decision_action_outcome_logs"],
      checkedAt: "2026-07-07T05:00:00.000Z",
    });
    const result = await runMetaOutcomeAccrualIfDue(new Date("2026-07-07T05:10:00.000Z"));
    expect(result).toMatchObject({ skipped: true, reason: "schema_not_ready" });
  });

  it("runs per active business in the due slot", async () => {
    vi.mocked(db.getDb).mockReturnValue(makeSqlMock({ candidates: [] }));
    const result = await runMetaOutcomeAccrualIfDue(new Date("2026-07-07T05:10:00.000Z"));
    expect(result.skipped).toBe(false);
    if (!result.skipped && result.results) {
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({ businessId: "biz_1", status: "fulfilled" });
    }
  });
});
