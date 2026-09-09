import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
/*
  The account/cutoff-scoped Meta-attributed purchase sample.

  ROUND 6 AUDIT ITEM 2: a rule firing on `target_roas` mints a purchase-BUDGET
  proposal, so the evaluator now refuses to run at all unless this account has
  a READY sample for the day being evaluated. A ready default keeps the cases
  below measuring what they were written to measure; the two new cases at the
  end drive it to missing and thin.
*/
vi.mock("@/lib/creative-decision-engine/meta-aov-calculator", () => ({
  computeMetaAttributedAov: vi.fn(async () => ({
    aovMean: 180,
    purchaseCount: 60,
    totalRevenue: 10_800,
  })),
}));
/*
  ── ROUND 8 ITEM 1: THE TARGET PACK IS READ AS OF THE CUTOFF ────────────────
  The evaluator no longer calls `getBusinessCommercialTruthSnapshot`, which is
  the CURRENT workspace pack. It calls `readMetaCommercialTargets(businessId,
  {asOf: cutoff})`, which reads `business_target_pack_history` through
  `getBusinessTargetPackHistoryAsOf`. So that is what these cases drive.

  `resolveBusinessTargetPackFreshness` is the REAL implementation, not a stub:
  freshness is what `hasMetaHardActionAnchor` gates purchase-value authority on,
  and stubbing it would let a pack with no provenance authorize a proposal —
  which is the exact defect this item closes. A pack therefore has to carry a
  real `updatedAt` at or before the cutoff to be usable, the same as in
  production.
*/
vi.mock("@/lib/business-commercial", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/business-commercial")>();
  return {
    getBusinessCommercialTruthSnapshot: vi.fn(),
    getBusinessTargetPackHistoryAsOf: vi.fn(async () => null),
    resolveBusinessTargetPackFreshness: actual.resolveBusinessTargetPackFreshness,
  };
});
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
const aovCalculator = await import(
  "@/lib/creative-decision-engine/meta-aov-calculator"
);

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

/**
 * A target pack as `business_target_pack_history` returns it AS OF the cutoff.
 *
 * `updatedAt` defaults to a real instant six days before the warehouse day the
 * cases use, so `resolveBusinessTargetPackFreshness` answers `fresh` and the
 * pack can anchor a hard action. Passing `updatedAt: null` is how a case drives
 * an unprovenanced pack.
 */
const PACK_UPDATED_AT = "2026-08-10T00:00:00.000Z";

function historicalPack(targetPack: unknown) {
  if (targetPack === null || targetPack === undefined) return null as never;
  return {
    updatedAt: PACK_UPDATED_AT,
    ...(targetPack as Record<string, unknown>),
  } as never;
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
  vi.mocked(aovCalculator.computeMetaAttributedAov).mockResolvedValue({
    aovMean: 180,
    purchaseCount: 60,
    totalRevenue: 10_800,
  } as never);
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
  /*
    ── ROUND 6 AUDIT ITEM 2: THE PROPOSAL PATH IS A PURCHASE-BUDGET PATH ────
    A rule that fires mints a live proposal, so the same commercial contract
    applies here as on every other purchase-budget surface. Two doors were open:

      - `anchorsFromTargetPack` exposed `target_cpa` / `break_even_cpa`, so an
        operator-authored CPA rule could evaluate and mint a proposal on an
        account whose only authoritative money-per-purchase is READY Meta AOV
        over its Target ROAS.
      - a ROAS rule could fire with no Meta-attributed sample behind the ratio
        at all.

    Both are closed here, and both fail closed by NAME rather than silently.
  */
  const roasGovernedPack = () =>
    historicalPack({
      targetRoas: 3.8,
      breakEvenRoas: 2.5,
      targetCpa: 42,
      breakEvenCpa: 55,
    });

  const threeLosingDays = () =>
    warehouseSql(
      [
        { entity_id: "adset_1", entity_name: "Retargeting", date: "2026-08-16", roas: 1.9, cpa: 60, spend: 100, revenue: 190 },
        { entity_id: "adset_1", entity_name: "Retargeting", date: "2026-08-15", roas: 1.8, cpa: 61, spend: 100, revenue: 180 },
        { entity_id: "adset_1", entity_name: "Retargeting", date: "2026-08-14", roas: 1.7, cpa: 62, spend: 100, revenue: 170 },
      ],
      "2026-08-16",
    ) as never;

  it("projects the CPA anchors to null while a Target ROAS governs", async () => {
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue(
      roasGovernedPack(),
    );
    vi.mocked(db.getDb).mockReturnValue(threeLosingDays());

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [RULE],
    });

    // The pack HAS both CPAs typed; the evaluator may not see them.
    expect(report.anchors).toMatchObject({
      target_roas: 3.8,
      break_even_roas: 2.5,
      target_cpa: null,
      break_even_cpa: null,
    });
  });

  it("keeps the CPA anchors when no Target ROAS governs", async () => {
    // The compatibility control: with no ratio to divide, the typed CPA IS the
    // anchor and a CPA rule is legitimately evaluable.
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue(
      historicalPack({
        targetRoas: null,
        breakEvenRoas: 2.5,
        targetCpa: 42,
        breakEvenCpa: 55,
      }),
    );
    vi.mocked(db.getDb).mockReturnValue(threeLosingDays());

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [RULE],
    });

    expect(report.anchors).toMatchObject({ target_cpa: 42, break_even_cpa: 55 });
  });

  it.each([
    ["a missing", null],
    ["a thin", { aovMean: 180, purchaseCount: 9, totalRevenue: 1620 }],
  ])("mints NO proposal on %s Meta sample while a Target ROAS governs", async (_case, sample) => {
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue(
      roasGovernedPack(),
    );
    vi.mocked(db.getDb).mockReturnValue(threeLosingDays());
    vi.mocked(aovCalculator.computeMetaAttributedAov).mockResolvedValue(
      sample as never,
    );

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [RULE],
    });

    expect(report.skippedReason).toBe("purchase_value_authority_missing");
    expect(report.evaluation).toBeNull();
    expect(report.recorded).toEqual([]);
    expect(store.recordRuleFirings).not.toHaveBeenCalled();
  });

  it("reads the sample for the evaluated ACCOUNT and DAY, and fails closed when it cannot", async () => {
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue(
      roasGovernedPack(),
    );
    vi.mocked(db.getDb).mockReturnValue(threeLosingDays());
    vi.mocked(aovCalculator.computeMetaAttributedAov).mockRejectedValue(
      new Error("sample read failed"),
    );

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      asOfDate: "2026-08-16",
      rules: [RULE],
    });

    expect(aovCalculator.computeMetaAttributedAov).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        providerAccountId: "act_1",
        asOf: "2026-08-16",
      }),
    );
    // An unreadable sample is not the same fact as a ready one.
    expect(report.skippedReason).toBe("purchase_value_authority_missing");
    expect(report.evaluation).toBeNull();
  });

  it("anchors the evaluation to the newest warehouse day rather than the wall clock", async () => {
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue(
      historicalPack({
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
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue(
      historicalPack(null),
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
    /*
      It reads the CUTOFF and stops.

      This used to assert the warehouse was not touched at all, which was true
      only because the anchors came from the current workspace pack and could
      therefore be read before any day was chosen. The cutoff now comes first —
      a point-in-time question cannot be asked before its own cutoff exists —
      so one `MAX(date)` read is expected and correct. What must NOT happen is
      the expensive part: no entity window is pulled once the pack in force on
      that day turns out to hold no anchor.
    */
    const queries = sql.mock.calls.map((call) =>
      Array.from(call[0] as TemplateStringsArray).join("?"),
    );
    expect(queries.filter((query) => query.includes("MAX(date)"))).toHaveLength(1);
    expect(
      queries.filter((query) => query.includes("entity_name")),
    ).toHaveLength(0);
  });

  it("skips inactive rules and guards without touching the warehouse", async () => {
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue(
      historicalPack({
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
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue(
      historicalPack({
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

  /*
    ── ROUND 8 ITEM 1: POINT-IN-TIME PROVENANCE ────────────────────────────────

    Three separate wall-clock reads decided economic authority here, and each
    of these cases drives one of them. Every one FAILS on the pre-fix code:

      1. the anchors came from `getBusinessCommercialTruthSnapshot` — the pack
         as it is NOW — so a target saved after the evaluated day changed a
         historical verdict;
      2. the Meta AOV was read at `input.asOfDate ?? new Date()`, so a
         scheduled run divided a warehouse-day ratio by a today-shaped AOV;
      3. the authority check was handed `freshness: "fresh"` and an `updatedAt`
         falling back to `new Date().toISOString()`, which is precisely what
         `hasMetaHardActionAnchor` exists to refuse.
  */
  it("derives BOTH the target read and the AOV read from the warehouse max when asOf is omitted", async () => {
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue(
      historicalPack({
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

    // ONE cutoff, reaching BOTH economic reads. Neither is the wall clock, and
    // neither is a different day from the other.
    expect(commercial.getBusinessTargetPackHistoryAsOf).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      asOf: "2026-08-16",
    });
    expect(aovCalculator.computeMetaAttributedAov).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        providerAccountId: "act_1",
        asOf: "2026-08-16",
      }),
    );
    expect(report.asOfDate).toBe("2026-08-16");
    expect(report.skippedReason).toBeNull();
  });

  it("does not let a target saved AFTER the cutoff change a historical result", async () => {
    /*
      The history reader is the authority, and it is asked for the cutoff day.
      A pack that only exists after that day is not visible to it — so this
      case gives the CURRENT snapshot a firing-strength target and the HISTORY
      an anchorless one, and requires the historical answer to win.

      Under the old code `getBusinessCommercialTruthSnapshot` supplied the
      anchors directly and this evaluation would have fired.
    */
    vi.mocked(commercial.getBusinessCommercialTruthSnapshot).mockResolvedValue({
      businessId: BUSINESS_ID,
      targetPack: {
        targetRoas: null,
        breakEvenRoas: 2.5,
        targetCpa: null,
        breakEvenCpa: null,
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    } as never);
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue(
      null as never,
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

    expect(report.skippedReason).toBe("no_commercial_anchors");
    expect(report.anchors).toEqual({
      target_roas: null,
      break_even_roas: null,
      target_cpa: null,
      break_even_cpa: null,
    });
    expect(store.recordRuleFirings).not.toHaveBeenCalled();
    // And the current-workspace reader was never consulted for authority.
    expect(commercial.getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
  });

  it("records nothing when the historical target read REJECTS", async () => {
    // Unreadable is not empty, and it is certainly not "fresh". The old code
    // could not reach this state at all: it synthesized the provenance it
    // needed.
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockRejectedValue(
      new Error("business_target_pack_history is not ready"),
    );
    vi.mocked(db.getDb).mockReturnValue(threeLosingDays());

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [RULE],
    });

    expect(report.skippedReason).toBe("commercial_targets_unreadable");
    expect(report.evaluation).toBeNull();
    expect(report.recorded).toEqual([]);
    expect(store.recordRuleFirings).not.toHaveBeenCalled();
    // Nothing was proposed on evidence nobody could read.
    expect(report.minRoasFloor).toBeNull();
  });

  it("records nothing when the historical pack carries NO usable provenance", async () => {
    /*
      A pack with no `updatedAt` cannot establish that it was in force. The old
      code passed `updatedAt: <snapshot value> ?? new Date().toISOString()` and
      `freshness: "fresh"` into the authority check, so this pack authorized
      purchase-budget proposals by asserting the provenance it lacks.
    */
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue({
      targetRoas: 3.8,
      breakEvenRoas: 2.5,
      targetCpa: null,
      breakEvenCpa: null,
      updatedAt: null,
    } as never);
    vi.mocked(db.getDb).mockReturnValue(threeLosingDays());

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [RULE],
    });

    expect(report.skippedReason).toBe("purchase_value_authority_missing");
    expect(store.recordRuleFirings).not.toHaveBeenCalled();
  });

  it("records nothing when the historical pack timestamp is an impossible date", async () => {
    // `2026-02-30` is not a day. `Date.parse` silently answers 2026-03-02 for
    // it, which used to make this pack `fresh` and hard-action anchored.
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue({
      targetRoas: 3.8,
      breakEvenRoas: 2.5,
      targetCpa: null,
      breakEvenCpa: null,
      updatedAt: "2026-02-30T00:00:00.000Z",
    } as never);
    vi.mocked(db.getDb).mockReturnValue(threeLosingDays());

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [RULE],
    });

    expect(report.skippedReason).toBe("purchase_value_authority_missing");
    expect(store.recordRuleFirings).not.toHaveBeenCalled();
  });

  it("produces the same report twice over an unchanged warehouse", async () => {
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue(
      historicalPack({
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
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue(
      historicalPack({
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
    /*
      The failure has to be one the evaluator does NOT absorb.

      A rejected target-pack read is now caught and reported as
      `commercial_targets_unreadable` on an otherwise successful account, which
      is the correct behaviour and no longer a thrown failure — so driving it
      here would silently stop testing what this case is about. The warehouse
      cutoff read is not absorbed, so that is what fails.
    */
    const failingSql = warehouseSql([]);
    failingSql.mockRejectedValueOnce(new Error("warehouse unavailable"));
    vi.mocked(db.getDb).mockReturnValueOnce(failingSql as never);
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue(
      historicalPack({
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
