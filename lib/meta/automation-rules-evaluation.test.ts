import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/business-commercial", () => ({
  getBusinessCommercialTruthSnapshot: vi.fn(),
}));
vi.mock("@/lib/meta/automation-rules-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/meta/automation-rules-store")
  >("@/lib/meta/automation-rules-store");
  return {
    ...actual,
    recordRuleFirings: vi.fn(async () => []),
    listAutomationRules: vi.fn(async () => []),
  };
});
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
}));
vi.mock("@/lib/sync/active-businesses", () => ({
  getActiveBusinesses: vi.fn(async () => []),
}));
vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(async () => []),
}));
vi.mock("@/lib/meta/automation-control-plane", () => ({
  getMetaWriteBlockState: vi.fn(async () => ({ blocked: false, reason: null, message: null, rehearsal: false })),
}));

const db = await import("@/lib/db");
const commercial = await import("@/lib/business-commercial");
const store = await import("@/lib/meta/automation-rules-store");
const activeBusinesses = await import("@/lib/sync/active-businesses");
const assignments = await import("@/lib/meta/creatives-fetchers");
const controlPlane = await import("@/lib/meta/automation-control-plane");
const {
  evaluateBusinessAutomationRules,
  runMetaAutomationRuleEvaluationIfDue,
} = await import("@/lib/meta/automation-rules-evaluation");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

const RULE = {
  id: "rule_1",
  businessId: BUSINESS_ID,
  name: "Breakeven guard",
  entityLevel: "adset" as const,
  trigger: {
    kind: "roas_below_anchor" as const,
    anchor: "break_even_roas" as const,
    anchorMultiplier: 1,
    consecutiveDays: 3,
  },
  action: { kind: "propose_pause" as const },
  mode: "confirm" as const,
  active: true,
  createdAt: null,
  updatedAt: null,
};

function snapshot(targetPack: unknown) {
  return { businessId: BUSINESS_ID, targetPack } as never;
}

function warehouseSql(rows: unknown[], maxDate: string | null = "2026-08-16") {
  return vi.fn(async (parts: TemplateStringsArray) => {
    const query = Array.from(parts).join("?");
    if (query.includes("MAX(date)")) return [{ max_date: maxDate }];
    if (query.includes("FROM meta_adset_daily")) return rows;
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.recordRuleFirings).mockResolvedValue([]);
  vi.mocked(store.listAutomationRules).mockResolvedValue([RULE]);
  vi.mocked(activeBusinesses.getActiveBusinesses).mockResolvedValue([
    { id: BUSINESS_ID, name: "Grandmix" },
  ] as never);
  vi.mocked(assignments.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
  vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({ blocked: false, reason: null, message: null, rehearsal: false });
});

/** 06:00 UTC — the slot the job runs in. */
const DUE = new Date("2026-08-18T06:12:00.000Z");
/*
  Before the window, not after it.

  The guard used to be `!== 6`, which made 09:12 "not due" — and also made a
  missed 06:00 tick lose the whole day. It is now a window opening at 06:00, so
  the only time nothing is due is before it opens; a late tick catches up and
  the per-firing dedupe key stops anything from firing twice.
*/
const NOT_DUE = new Date("2026-08-18T05:12:00.000Z");
const LATE_TICK = new Date("2026-08-18T09:12:00.000Z");

describe("evaluateBusinessAutomationRules", () => {
  it("anchors the evaluation to the newest warehouse day rather than the wall clock", async () => {
    vi.mocked(commercial.getBusinessCommercialTruthSnapshot).mockResolvedValue(
      snapshot({
        targetRoas: 3.8,
        breakEvenRoas: 2.5,
        targetCpa: null,
        breakEvenCpa: null,
      }),
    );
    vi.mocked(db.getDb).mockReturnValue(
      warehouseSql(
        [
          { entity_id: "adset_1", entity_name: "Retargeting", date: "2026-08-16", roas: 1.9, cpa: null, spend: 100, revenue: 190 },
          { entity_id: "adset_1", entity_name: "Retargeting", date: "2026-08-15", roas: 1.8, cpa: null, spend: 100, revenue: 180 },
          { entity_id: "adset_1", entity_name: "Retargeting", date: "2026-08-14", roas: 1.7, cpa: null, spend: 100, revenue: 170 },
        ],
        "2026-08-16",
      ) as never,
    );

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [RULE],
    });

    expect(report.asOfDate).toBe("2026-08-16");
    expect(report.skippedReason).toBeNull();
    expect(report.evaluation?.verdicts[0]).toMatchObject({
      status: "fires",
      outcome: "proposal",
      dedupeKey: "rule_1:adset_1:2026-08-16",
    });
    expect(store.recordRuleFirings).toHaveBeenCalledTimes(1);
  });

  it("refuses to evaluate at all when the Commercial Truth pack supplies no anchor", async () => {
    vi.mocked(commercial.getBusinessCommercialTruthSnapshot).mockResolvedValue(
      snapshot(null),
    );
    const sql = warehouseSql([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [RULE],
    });

    expect(report.skippedReason).toBe("no_commercial_anchors");
    expect(report.evaluation).toBeNull();
    expect(store.recordRuleFirings).not.toHaveBeenCalled();
    // It does not even read the warehouse without something to compare against.
    expect(sql).not.toHaveBeenCalled();
  });

  it("skips inactive rules and guards without touching the warehouse", async () => {
    vi.mocked(commercial.getBusinessCommercialTruthSnapshot).mockResolvedValue(
      snapshot({
        targetRoas: 3.8,
        breakEvenRoas: 2.5,
        targetCpa: null,
        breakEvenCpa: null,
      }),
    );
    const sql = warehouseSql([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [
        { ...RULE, active: false },
        {
          ...RULE,
          id: "rule_guard",
          mode: "enforced" as const,
          trigger: {
            kind: "quiet_hours" as const,
            timeZone: "America/New_York",
            startHour: 0,
            endHour: 7,
          },
          action: { kind: "hard_block_writes" as const },
        },
      ],
    });

    expect(report.skippedReason).toBe("no_rules");
    expect(sql).not.toHaveBeenCalled();
    expect(store.recordRuleFirings).not.toHaveBeenCalled();
  });

  it("reports missing history instead of firing on a thin warehouse", async () => {
    vi.mocked(commercial.getBusinessCommercialTruthSnapshot).mockResolvedValue(
      snapshot({
        targetRoas: null,
        breakEvenRoas: 2.5,
        targetCpa: null,
        breakEvenCpa: null,
      }),
    );
    vi.mocked(db.getDb).mockReturnValue(warehouseSql([], null) as never);

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [RULE],
    });

    expect(report.skippedReason).toBe("no_warehouse_history");
    expect(report.evaluation).toBeNull();
  });

  it("produces the same report twice over an unchanged warehouse", async () => {
    vi.mocked(commercial.getBusinessCommercialTruthSnapshot).mockResolvedValue(
      snapshot({
        targetRoas: 3.8,
        breakEvenRoas: 2.5,
        targetCpa: null,
        breakEvenCpa: null,
      }),
    );
    const rows = [
      { entity_id: "adset_1", entity_name: "A", date: "2026-08-16", roas: 1.9, cpa: null, spend: 100, revenue: 190 },
      { entity_id: "adset_1", entity_name: "A", date: "2026-08-15", roas: 1.8, cpa: null, spend: 100, revenue: 180 },
      { entity_id: "adset_1", entity_name: "A", date: "2026-08-14", roas: 1.7, cpa: null, spend: 100, revenue: 170 },
      { entity_id: "adset_2", entity_name: "B", date: "2026-08-16", roas: 9.9, cpa: null, spend: 100, revenue: 990 },
    ];
    vi.mocked(db.getDb).mockReturnValue(warehouseSql(rows) as never);

    const first = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [RULE],
    });
    const second = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [RULE],
    });

    expect(second.evaluation).toEqual(first.evaluation);
  });
});

/**
 * The scheduled caller. Without it the evaluator had no production trigger at
 * all: a rule an operator armed could never fire, and "Fired · 28d" would have
 * stayed `0×` forever while looking like a measured zero.
 */
describe("runMetaAutomationRuleEvaluationIfDue", () => {
  function warehouseReady() {
    vi.mocked(commercial.getBusinessCommercialTruthSnapshot).mockResolvedValue(
      snapshot({
        targetRoas: 3.8,
        breakEvenRoas: 2.5,
        targetCpa: null,
        breakEvenCpa: null,
      }),
    );
    vi.mocked(db.getDb).mockReturnValue(
      warehouseSql([
        { entity_id: "adset_1", entity_name: "Retargeting", date: "2026-08-16", roas: 1.9, cpa: null, spend: 100, revenue: 190 },
        { entity_id: "adset_1", entity_name: "Retargeting", date: "2026-08-15", roas: 1.8, cpa: null, spend: 100, revenue: 180 },
        { entity_id: "adset_1", entity_name: "Retargeting", date: "2026-08-14", roas: 1.7, cpa: null, spend: 100, revenue: 170 },
      ]) as never,
    );
  }

  it("evaluates every assigned account of a business that has an armed rule", async () => {
    warehouseReady();
    vi.mocked(assignments.fetchAssignedAccountIds).mockResolvedValue([
      "act_1",
      "act_2",
    ]);

    const result = await runMetaAutomationRuleEvaluationIfDue(DUE);

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.businesses[0].accounts.map((a) => a.providerAccountId)).toEqual(
      ["act_1", "act_2"],
    );
    expect(store.recordRuleFirings).toHaveBeenCalledTimes(2);
  });

  it("does nothing before its window opens", async () => {
    const result = await runMetaAutomationRuleEvaluationIfDue(NOT_DUE);

    expect(result).toMatchObject({ skipped: true, reason: "not_due" });
    expect(activeBusinesses.getActiveBusinesses).not.toHaveBeenCalled();
    expect(store.recordRuleFirings).not.toHaveBeenCalled();
  });

  it("still runs on a tick three hours late", async () => {
    // The case the old equality lost silently: a deploy or a slow tick at
    // 06:00 used to cost the day's rule evaluation entirely.
    warehouseReady();
    const result = await runMetaAutomationRuleEvaluationIfDue(LATE_TICK);

    expect(result.skipped).toBe(false);
    expect(activeBusinesses.getActiveBusinesses).toHaveBeenCalled();
  });

  // The operator's STOP means "stop automation", and a queue built while it is
  // engaged is a queue nothing may approve. An unreadable control state gets the
  // same treatment: it fails closed rather than guessing the switch is off.
  it("raises nothing for a business whose Meta writes are blocked", async () => {
    warehouseReady();
    vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({
      blocked: true,
      reason: "business_kill_switch",
      message: "Operator stop.",
      rehearsal: true,
    });

    const result = await runMetaAutomationRuleEvaluationIfDue(DUE);

    if (result.skipped) throw new Error("unreachable");
    expect(result.businesses[0]).toMatchObject({
      skippedReason: "writes_blocked",
      blockReason: "business_kill_switch",
    });
    expect(store.recordRuleFirings).not.toHaveBeenCalled();
  });

  it("fails closed when the control state cannot be read at all", async () => {
    warehouseReady();
    vi.mocked(controlPlane.getMetaWriteBlockState).mockRejectedValue(
      new Error("db down"),
    );

    const result = await runMetaAutomationRuleEvaluationIfDue(DUE);

    if (result.skipped) throw new Error("unreachable");
    expect(result.businesses[0]).toMatchObject({
      skippedReason: "writes_blocked",
      blockReason: "control_state_unavailable",
    });
    expect(store.recordRuleFirings).not.toHaveBeenCalled();
  });

  it("skips a business with no armed rule before reading its control state", async () => {
    vi.mocked(store.listAutomationRules).mockResolvedValue([
      { ...RULE, active: false },
    ]);

    const result = await runMetaAutomationRuleEvaluationIfDue(DUE);

    if (result.skipped) throw new Error("unreachable");
    expect(result.businesses[0]).toMatchObject({ skippedReason: "no_rules" });
    expect(controlPlane.getMetaWriteBlockState).not.toHaveBeenCalled();
    expect(assignments.fetchAssignedAccountIds).not.toHaveBeenCalled();
  });

  it("keeps one failing business from costing every other business its evaluation", async () => {
    warehouseReady();
    vi.mocked(activeBusinesses.getActiveBusinesses).mockResolvedValue([
      { id: BUSINESS_ID, name: "A" },
      { id: "0b3f5c2e-1111-4222-8333-444455556666", name: "B" },
    ] as never);
    vi.mocked(commercial.getBusinessCommercialTruthSnapshot)
      .mockRejectedValueOnce(new Error("commercial truth unavailable"))
      .mockResolvedValue(
        snapshot({
          targetRoas: 3.8,
          breakEvenRoas: 2.5,
          targetCpa: null,
          breakEvenCpa: null,
        }),
      );

    const result = await runMetaAutomationRuleEvaluationIfDue(DUE);

    if (result.skipped) throw new Error("unreachable");
    expect(result.businesses[0].accounts[0]).toMatchObject({
      status: "failed",
    });
    expect(result.businesses[1].accounts[0]).toMatchObject({
      status: "evaluated",
    });
  });
});

describe("the periodic evaluation is gated on stops, not on quiet hours", () => {
  /**
   * The job runs in one UTC hour. If a quiet-hours window covering that hour
   * skipped it, the business would be evaluated on no day at all — the exact
   * permanently-zero `firedCount` this job exists to close, hidden as a skip
   * reason inside the cron receipt.
   *
   * Nothing is written by evaluating: a firing's strongest outcome is a proposal
   * an operator still has to approve, and that approval re-checks the guard.
   */
  it("still evaluates a business whose writes are blocked only by a guard rule", async () => {
    const gate = vi.mocked(controlPlane.getMetaWriteBlockState);
    gate.mockResolvedValue({
      blocked: true,
      reason: "automation_guard_rule",
      message: "Quiet hours are in effect.",
      guardRule: null,
      rehearsal: true,
    });

    const result = await runMetaAutomationRuleEvaluationIfDue(
      DUE,
    );

    const skipped = result.skipped
      ? []
      : result.businesses.filter(
          (outcome) => outcome.skippedReason === "writes_blocked",
        );
    expect(skipped).toHaveLength(0);
  });

  it("still refuses a business under a stop", async () => {
    const gate = vi.mocked(controlPlane.getMetaWriteBlockState);
    gate.mockResolvedValue({
      blocked: true,
      reason: "business_kill_switch",
      message: "Automation is stopped for this business.",
      rehearsal: true,
    });

    const result = await runMetaAutomationRuleEvaluationIfDue(
      DUE,
    );

    const skipped = result.skipped
      ? []
      : result.businesses.filter(
          (outcome) => outcome.skippedReason === "writes_blocked",
        );
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]?.blockReason).toBe("business_kill_switch");
  });
});
