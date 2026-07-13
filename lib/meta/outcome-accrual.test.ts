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

function makeSqlMock(input: {
  candidates?: Array<Record<string, unknown>>;
  kpiRows?: Array<Record<string, unknown>>;
  actedRows?: Array<Record<string, unknown>>;
}) {
  const tag = vi.fn((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("FROM meta_decision_snapshots_daily")) {
      return Promise.resolve(input.candidates ?? []);
    }
    if (text.includes("FROM meta_decision_responses")) {
      return Promise.resolve(input.actedRows ?? []);
    }
    return Promise.resolve([]);
  }) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn((text: string) => {
    if (text.includes("FROM meta_campaign_daily") || text.includes("FROM meta_adset_daily")) {
      return Promise.resolve(input.kpiRows ?? []);
    }
    return Promise.resolve([]);
  }) as never;
  return tag;
}

describe("runMetaOutcomeAccrualForBusiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
