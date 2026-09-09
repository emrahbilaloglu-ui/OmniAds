/**
 * The two guardrails an operator commits by hand, asserted where they actually
 * bind rather than where they are merely displayed.
 *
 * Both were persisted, rendered, and then ignored. A safety control the product
 * shows but does not honour is worse than none, so each one is pinned here at
 * its enforcement point:
 *
 *   - the quiet-hours window, at the single provider-write boundary, and
 *   - the ROAS proposal floor, at BOTH producers of a queue row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
}));
/*
  ── ROUND 9 ITEM 10: STALE SINCE ROUND 8, AND NEVER RUN ────────────────────
  Round 8 stopped `evaluateBusinessAutomationRules` from reading the CURRENT
  workspace pack and made it read `business_target_pack_history` AS OF the
  evaluation cutoff. This suite still mocked only the current-snapshot reader,
  so every case here evaluated with no anchors at all and returned
  `commercial_targets_unreadable` before reaching the ROAS floor it exists to
  test. It was not in Round 8's targeted set.

  `resolveBusinessTargetPackFreshness` is the REAL implementation for the same
  reason it is in `automation-rules-evaluation.test.ts`: freshness is what
  `hasMetaHardActionAnchor` gates purchase-value authority on, and stubbing it
  would let an unprovenanced pack authorize a proposal.
*/
/*
  The account/cutoff-scoped Meta-attributed purchase sample.

  A rule firing on `target_roas` mints a purchase-BUDGET proposal, so Round 8's
  authority gate refuses to evaluate at all without a READY sample for the
  evaluated account and day. This suite is about the ROAS FLOOR, so the sample
  is ready by default and the gate stays out of its way.
*/
vi.mock("@/lib/creative-decision-engine/meta-aov-calculator", () => ({
  computeMetaAttributedAov: vi.fn(async () => ({
    aovMean: 180,
    purchaseCount: 60,
    totalRevenue: 10_800,
  })),
}));
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
  return { ...actual, recordRuleFirings: vi.fn(async () => []) };
});

const db = await import("@/lib/db");
const commercial = await import("@/lib/business-commercial");
const store = await import("@/lib/meta/automation-rules-store");
const { getMetaWriteBlockState } = await import(
  "@/lib/meta/automation-control-plane"
);
const { evaluateBusinessAutomationRules } = await import(
  "@/lib/meta/automation-rules-evaluation"
);
const { projectMetaAutomationProposals } = await import(
  "@/lib/meta/automation-proposals"
);

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

/** Every family armed for confirmation: the posture that projects. */
const SEMI_AUTO_MODES = {
  pause: "semi_auto",
  bid: "semi_auto",
  budget: "semi_auto",
  creative: "semi_auto",
} as const;

const OPEN_CONTROL_ROW = {
  business_id: BUSINESS_ID,
  is_demo_business: false,
  kill_switch_engaged: false,
  kill_switch_reason: null,
  auto_execution_enabled: false,
  readiness_tier: "manual_review",
  guardrails_json: {},
  updated_at: "2026-08-17T08:00:00.000Z",
  updated_by: "user_1",
  min_roas_floor: null,
  quiet_hours_start: null,
  quiet_hours_end: null,
  quiet_hours_timezone: null,
};

/**
 * A control row carrying a persisted quiet-hours window, plus an empty rule
 * table. Nothing here is an `enforced` rule: the point is that the operator's
 * OWN window binds on its own.
 */
function controlPlaneSql(
  quietHours: {
    start: string | null;
    end: string | null;
    timezone: string | null;
  },
  rules: unknown = [],
) {
  return vi.fn(async (parts: TemplateStringsArray) => {
    const query = Array.from(parts).join("?");
    if (query.includes("LEFT JOIN meta_automation_business_controls")) {
      return [
        {
          ...OPEN_CONTROL_ROW,
          quiet_hours_start: quietHours.start,
          quiet_hours_end: quietHours.end,
          quiet_hours_timezone: quietHours.timezone,
        },
      ];
    }
    if (query.includes("FROM meta_automation_rules")) {
      if (rules instanceof Error) throw rules;
      return rules;
    }
    return [];
  });
}

describe("the persisted quiet-hours window refuses provider writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("META_AUTOMATION_WRITE_GUARD_TEST_READS", "1");
    /*
      The release capability, opened so these cases are about QUIET HOURS.

      The shared block refuses every product write while the capability is
      shut, and it answers before the guardrails — it is the cheapest fact and
      the one a deployment controls. Left closed, all seven cases below would
      read `release_capability_closed` and prove nothing about the operator's
      own window. The closed answer is covered by
      `lib/meta/write-posture-enforcement.test.ts`.
    */
    vi.stubEnv("META_AUTOMATION_LIVE_WRITES", "true");
  });

  it("refuses a write inside the configured window", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      controlPlaneSql({
        start: "09:00",
        end: "17:00",
        timezone: "America/New_York",
      }) as never,
    );

    const block = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      // 14:00 in New York.
      at: new Date("2026-08-17T18:00:00.000Z"),
    });

    expect(block).toMatchObject({
      blocked: true,
      // The same reason code an `enforced` quiet-hours rule returns: one
      // concept, one refusal, indistinguishable downstream.
      reason: "automation_guard_rule",
    });
    expect(block.message).toContain("09:00");
    expect(block.message).toContain("17:00");
  });

  it("permits a write outside the window, leaving today's behaviour unchanged", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      controlPlaneSql({
        start: "09:00",
        end: "17:00",
        timezone: "America/New_York",
      }) as never,
    );

    const block = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      // 04:00 in New York.
      at: new Date("2026-08-17T08:00:00.000Z"),
    });

    /*
      Not blocked, and still rehearsing.

      `guardrails_json` carries no explicit `dryRunOnly: false`, and the
      default is rehearsal — a business that has never committed to live
      writes gets one. "Not blocked" and "will reach Meta" are two facts, and
      the shared posture reports both.
    */
    expect(block).toEqual({
      blocked: false, reason: null, message: null, rehearsal: true,
    });
  });

  it("honours a window that crosses midnight", async () => {
    const window = {
      start: "22:00",
      end: "06:00",
      timezone: "America/New_York",
    };

    vi.mocked(db.getDb).mockReturnValue(controlPlaneSql(window) as never);
    const insideAfterMidnight = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      // 02:00 in New York — after midnight, still inside 22:00–06:00.
      at: new Date("2026-08-17T06:00:00.000Z"),
    });
    expect(insideAfterMidnight).toMatchObject({
      blocked: true,
      reason: "automation_guard_rule",
    });

    vi.mocked(db.getDb).mockReturnValue(controlPlaneSql(window) as never);
    const insideBeforeMidnight = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      // 23:00 in New York — before midnight, inside the same window.
      at: new Date("2026-08-18T03:00:00.000Z"),
    });
    expect(insideBeforeMidnight).toMatchObject({
      blocked: true,
      reason: "automation_guard_rule",
    });

    vi.mocked(db.getDb).mockReturnValue(controlPlaneSql(window) as never);
    const outside = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      // 12:00 in New York — squarely outside.
      at: new Date("2026-08-17T16:00:00.000Z"),
    });
    expect(outside).toEqual({
      blocked: false, reason: null, message: null, rehearsal: true,
    });
  });

  it("respects the minute, not just the hour", async () => {
    const window = {
      start: "22:30",
      end: "06:15",
      timezone: "America/New_York",
    };

    vi.mocked(db.getDb).mockReturnValue(controlPlaneSql(window) as never);
    const justBefore = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      // 22:29 in New York.
      at: new Date("2026-08-18T02:29:00.000Z"),
    });
    expect(justBefore).toEqual({
      blocked: false, reason: null, message: null, rehearsal: true,
    });

    vi.mocked(db.getDb).mockReturnValue(controlPlaneSql(window) as never);
    const justInside = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      // 22:31 in New York.
      at: new Date("2026-08-18T02:31:00.000Z"),
    });
    expect(justInside).toMatchObject({
      blocked: true,
      reason: "automation_guard_rule",
    });
  });

  it("fails CLOSED when the persisted timezone cannot be resolved", async () => {
    // "ET" is a display label, not an IANA zone. The window cannot be located
    // on the clock, so the write is refused rather than waved through.
    vi.mocked(db.getDb).mockReturnValue(
      controlPlaneSql({ start: "00:00", end: "07:00", timezone: "ET" }) as never,
    );

    const block = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      at: new Date("2026-08-17T16:00:00.000Z"),
    });

    expect(block).toMatchObject({
      blocked: true,
      reason: "automation_guard_rule",
    });
    expect(block.message).toContain("ET");
  });

  it("keeps refusing when the rules table does not exist at all", async () => {
    // The window is not a rule. An un-migrated rules table must not be able to
    // lift a guardrail that lives in a different table.
    const missingTable = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    vi.mocked(db.getDb).mockReturnValue(
      controlPlaneSql(
        { start: "09:00", end: "17:00", timezone: "America/New_York" },
        missingTable,
      ) as never,
    );

    const block = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      at: new Date("2026-08-17T18:00:00.000Z"),
    });

    expect(block).toMatchObject({
      blocked: true,
      reason: "automation_guard_rule",
    });
  });

  it("does nothing at all when no window is persisted", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      controlPlaneSql({ start: null, end: null, timezone: null }) as never,
    );

    const block = await getMetaWriteBlockState({
      businessId: BUSINESS_ID,
      at: new Date("2026-08-17T18:00:00.000Z"),
    });

    /*
      Not blocked, and still rehearsing.

      `guardrails_json` carries no explicit `dryRunOnly: false`, and the
      default is rehearsal — a business that has never committed to live
      writes gets one. "Not blocked" and "will reach Meta" are two facts, and
      the shared posture reports both.
    */
    expect(block).toEqual({
      blocked: false, reason: null, message: null, rehearsal: true,
    });
  });
});

const FLOOR_RULE = {
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
 * Warehouse double for the rule evaluator, plus the one column the ROAS floor
 * lives in. `floor` of `undefined` means the read itself fails.
 */
function evaluationSql(input: {
  daily: Array<{
    date: string;
    roas: number | null;
    spend: number | null;
    revenue: number | null;
  }>;
  floor: number | null | Error;
}) {
  return vi.fn(async (parts: TemplateStringsArray) => {
    const query = Array.from(parts).join("?");
    if (query.includes("meta_automation_business_controls")) {
      if (input.floor instanceof Error) throw input.floor;
      return [{ min_roas_floor: input.floor }];
    }
    if (query.includes("MAX(date)")) return [{ max_date: "2026-08-16" }];
    if (query.includes("FROM meta_adset_daily")) {
      return input.daily.map((row) => ({
        entity_id: "adset_1",
        entity_name: "Retargeting 7d — DPA",
        date: row.date,
        roas: row.roas,
        cpa: null,
        spend: row.spend,
        revenue: row.revenue,
      }));
    }
    return [];
  });
}

function daily(series: Array<{ roas: number | null; spend: number | null }>) {
  return series.map((row, index) => ({
    date: `2026-08-${String(16 - index).padStart(2, "0")}`,
    roas: row.roas,
    spend: row.spend,
    revenue:
      row.roas === null || row.spend === null ? null : row.roas * row.spend,
  }));
}

describe("the ROAS floor gates the rule evaluator's proposals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(store.recordRuleFirings).mockResolvedValue([]);
    vi.mocked(commercial.getBusinessTargetPackHistoryAsOf).mockResolvedValue({
      targetRoas: 3.8,
      breakEvenRoas: 2.5,
      targetCpa: null,
      breakEvenCpa: null,
      // Real provenance, before the evaluation cutoff, so the pack can anchor a
      // hard action on its own terms.
      updatedAt: "2026-08-10T00:00:00.000Z",
    } as never);
  });

  it("raises no proposal for an entity performing at or above the floor", async () => {
    // The rule fires (ROAS < breakeven 2.5 for 3 days) but the operator said
    // "only propose a pause below 1.50", and this entity is above that.
    vi.mocked(db.getDb).mockReturnValue(
      evaluationSql({
        daily: daily([
          { roas: 1.9, spend: 100 },
          { roas: 1.8, spend: 100 },
          { roas: 1.7, spend: 100 },
        ]),
        floor: 1.5,
      }) as never,
    );

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [FLOOR_RULE],
    });

    expect(
      report.evaluation?.verdicts.filter(
        (verdict) => verdict.status === "fires",
      ),
    ).toEqual([]);
    expect(report.evaluation?.verdicts[0]).toMatchObject({
      status: "suppressed",
      reason: "roas_at_or_above_floor",
    });
  });

  it("still raises the proposal for an entity proven below the floor", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      evaluationSql({
        daily: daily([
          { roas: 1.4, spend: 100 },
          { roas: 1.3, spend: 100 },
          { roas: 1.2, spend: 100 },
        ]),
        floor: 1.5,
      }) as never,
    );

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [FLOOR_RULE],
    });

    expect(report.evaluation?.verdicts[0]).toMatchObject({
      status: "fires",
      outcome: "proposal",
    });
  });

  it("does not let an unknown ROAS pass the floor", async () => {
    // A zero-spend day serves `roas = 0` from a NOT NULL DEFAULT 0 column. That
    // is a default, not a measurement, so it is not proof of being below the
    // floor — and the least-informed entity must not sail through the tightest
    // guardrail.
    vi.mocked(db.getDb).mockReturnValue(
      evaluationSql({
        daily: daily([
          { roas: 1.4, spend: 100 },
          { roas: 0, spend: 0 },
          { roas: 1.2, spend: 100 },
        ]),
        floor: 1.5,
      }) as never,
    );

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [FLOOR_RULE],
    });

    expect(
      report.evaluation?.verdicts.filter(
        (verdict) => verdict.status === "fires",
      ),
    ).toEqual([]);
    expect(report.evaluation?.verdicts[0]).toMatchObject({
      status: "suppressed",
      reason: "roas_floor_unprovable",
    });
  });

  it("changes nothing when no floor is persisted", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      evaluationSql({
        daily: daily([
          { roas: 1.9, spend: 100 },
          { roas: 1.8, spend: 100 },
          { roas: 1.7, spend: 100 },
        ]),
        floor: null,
      }) as never,
    );

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [FLOOR_RULE],
    });

    expect(report.evaluation?.verdicts[0]).toMatchObject({ status: "fires" });
  });

  it("refuses to evaluate at all when the floor cannot be read", async () => {
    const dbError = Object.assign(new Error("database unavailable"), {
      code: "57P01",
    });
    vi.mocked(db.getDb).mockReturnValue(
      evaluationSql({
        daily: daily([
          { roas: 1.4, spend: 100 },
          { roas: 1.3, spend: 100 },
          { roas: 1.2, spend: 100 },
        ]),
        floor: dbError,
      }) as never,
    );

    const report = await evaluateBusinessAutomationRules({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      rules: [FLOOR_RULE],
    });

    expect(report.skippedReason).toBe("roas_floor_unreadable");
    expect(report.evaluation).toBeNull();
    expect(store.recordRuleFirings).not.toHaveBeenCalled();
  });
});

describe("the ROAS floor gates the engine-decision projection", () => {
  function projectionDb(floor: number | null | Error) {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const tagged = vi.fn(async (parts: TemplateStringsArray) => {
      const query = Array.from(parts).join("?");
      if (query.includes("meta_automation_business_controls")) {
        if (floor instanceof Error) throw floor;
        return [{ min_roas_floor: floor }];
      }
      return [];
    });
    (tagged as unknown as { query: unknown }).query = (
      text: string,
      values: unknown[],
    ) => {
      calls.push({ text, values });
      return Promise.resolve([]);
    };
    return { tagged, calls };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds the persisted floor into the projecting statement and requires proof", async () => {
    const { tagged, calls } = projectionDb(1.5);
    vi.mocked(db.getDb).mockReturnValue(tagged as never);

    const result = await projectMetaAutomationProposals({
      businessId: BUSINESS_ID,
      snapshotDate: "2026-08-16",
      providerAccountIds: ["act_123"],
      now: new Date("2026-08-17T12:00:00.000Z"),
      // The queue only fills for a family the operator armed. This suite is
      // about the ROAS floor, so the standing mode is stated rather than left
      // to a control plane it does not mock.
      readModes: async () => SEMI_AUTO_MODES,
    });

    expect(result.ran).toBe(true);
    const insert = calls.find((call) =>
      call.text.includes("INSERT INTO meta_automation_proposals"),
    );
    expect(insert).toBeDefined();
    // The floor travels as a bound value, never interpolated.
    expect(insert!.values).toContain(1.5);
    const statement = insert!.text.replace(/\s+/g, " ");
    // A proposal needs a served, spend-backed ROAS strictly below the floor,
    // read from the warehouse day the decision is about.
    expect(statement).toContain("meta_campaign_daily");
    expect(statement).toContain("meta_adset_daily");
    expect(statement).toMatch(/spend > 0/);
    expect(statement).toMatch(/roas < \$\d/);
  });

  it("projects exactly as before when no floor is persisted", async () => {
    const { tagged, calls } = projectionDb(null);
    vi.mocked(db.getDb).mockReturnValue(tagged as never);

    const result = await projectMetaAutomationProposals({
      businessId: BUSINESS_ID,
      snapshotDate: "2026-08-16",
      providerAccountIds: ["act_123"],
      now: new Date("2026-08-17T12:00:00.000Z"),
      // The queue only fills for a family the operator armed. This suite is
      // about the ROAS floor, so the standing mode is stated rather than left
      // to a control plane it does not mock.
      readModes: async () => SEMI_AUTO_MODES,
    });

    expect(result.ran).toBe(true);
    expect(
      calls.some((call) =>
        call.text.includes("INSERT INTO meta_automation_proposals"),
      ),
    ).toBe(true);
  });

  it("projects nothing when the floor cannot be read", async () => {
    const dbError = Object.assign(new Error("database unavailable"), {
      code: "57P01",
    });
    const { tagged, calls } = projectionDb(dbError);
    vi.mocked(db.getDb).mockReturnValue(tagged as never);

    const result = await projectMetaAutomationProposals({
      businessId: BUSINESS_ID,
      snapshotDate: "2026-08-16",
      providerAccountIds: ["act_123"],
      now: new Date("2026-08-17T12:00:00.000Z"),
      // The queue only fills for a family the operator armed. This suite is
      // about the ROAS floor, so the standing mode is stated rather than left
      // to a control plane it does not mock.
      readModes: async () => SEMI_AUTO_MODES,
    });

    expect(result).toEqual({ projected: 0, expired: 0, ran: false });
    expect(
      calls.some((call) =>
        call.text.includes("INSERT INTO meta_automation_proposals"),
      ),
    ).toBe(false);
  });
});
