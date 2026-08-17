import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/business-commercial", () => ({
  getBusinessCommercialTruthSnapshot: vi.fn(),
}));
vi.mock("@/lib/meta/automation-rules-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/meta/automation-rules-store")
  >("@/lib/meta/automation-rules-store");
  return { ...actual, recordRuleFirings: vi.fn(async () => []) };
});

const db = await import("@/lib/db");
const commercial = await import("@/lib/business-commercial");
const store = await import("@/lib/meta/automation-rules-store");
const { evaluateBusinessAutomationRules } = await import(
  "@/lib/meta/automation-rules-evaluation"
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
});

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
