import { describe, expect, it } from "vitest";
import {
  H7_STRUCTURE_MATURITY_GRID,
  H9_ANNUAL_SEASONALITY_ELIMINATION,
  H9_ANNUAL_SEASONALITY_ELIMINATION_REASON,
  H9_STRUCTURE_HISTORY_GRID,
  H9_STRUCTURE_HISTORY_LOOKBACK_DAYS,
  STRUCTURE_OUTCOME_WINDOWS,
  STRUCTURE_REPLAY_CADENCE_ANCHOR,
  buildStructureReplayProtocol,
  buildFixedStructureOpportunityDates,
  buildStructureVariantGrid,
  calculateStructureWeightedMetrics,
  calculateStructureWeightedRoas,
  classifyStructureDurabilityOutcome,
  differenceInStructureReplayDays,
  evaluateStructureCandidate,
  hashFixedStructureCohort,
  normalizeMetaBudgetMinorUnits,
  normalizeStructureBidRegime,
  normalizeStructureGoalKey,
  resolveStructureBudgetOwner,
  resolveStructureReplayPhase,
  scoreStructureVariant,
  structureHistoryFactMatchesSeasonality,
  structureHistorySignalKey,
  structurePeerCohortKey,
  structureRecencyWeight,
  type StructureOpportunity,
  type StructureVariant,
} from "./structure-replay";

const baselineVariant: StructureVariant = {
  id: "baseline",
  ageDays: 14,
  purchaseThreshold: 8,
  utilization: 0.8,
  halfLifeDays: 28,
  supportDays: 2,
  seasonality: "none",
};

const baselineHistoryKey = structureHistorySignalKey({
  halfLifeDays: baselineVariant.halfLifeDays,
  seasonality: baselineVariant.seasonality,
});

function opportunity(
  input: Partial<StructureOpportunity> = {},
): StructureOpportunity {
  return {
    grain: "campaign",
    entityId: "campaign-1",
    businessId: "business-1",
    accountId: "account-1",
    currency: "USD",
    goalKey: "optimization:purchase",
    cohort: "purchase",
    bidRegime: "lowest_cost",
    bidValue: null,
    bidValueFormat: null,
    bidContextReconstructable: true,
    asOfDate: "2026-06-01",
    ageDays: 30,
    cumulativePurchases: 20,
    cumulativeConversions: 20,
    budgetUtilization: 0.9,
    budgetOwner: "campaign",
    budgetOrigin: "campaign_config",
    budgetOwnerReconstructable: false,
    statusReconstructable: false,
    configCutoffSafe: true,
    targetCutoffSafe: true,
    targetFresh: true,
    targetRoas: 2.5,
    breakEvenRoas: 1.5,
    targetCpa: null,
    breakEvenCpa: null,
    completeOutcomeReceipt: true,
    purchaseCohort: true,
    history: {
      [baselineHistoryKey]: {
        weightedRoas: 3,
        weightedCostPerResult: 10,
        peerRoasP75: 2.5,
        peerCostPerResultP25: 12,
        peerWinnerPurchaseP50: 24,
        peerWinnerOutcomeCountP50: 24,
        consecutiveSupportDays: 3,
        peerCount: 5,
      },
    },
    outcome: "supported",
    criticalRefutation: false,
    outcomes: {},
    ...input,
  };
}

describe("structure replay candidate grid", () => {
  it("exhausts every bounded H7/H9 combination exactly once", () => {
    const grid = buildStructureVariantGrid();
    expect(grid).toHaveLength(
      H7_STRUCTURE_MATURITY_GRID.ageDays.length *
        H7_STRUCTURE_MATURITY_GRID.purchaseThresholds.length *
        H7_STRUCTURE_MATURITY_GRID.utilization.length *
        H9_STRUCTURE_HISTORY_GRID.halfLifeDays.length *
        H9_STRUCTURE_HISTORY_GRID.supportDays.length *
        H9_STRUCTURE_HISTORY_GRID.seasonalityModes.length,
    );
    expect(new Set(grid.map((variant) => variant.id)).size).toBe(grid.length);
    expect(grid).toHaveLength(1536);
    expect(
      grid.filter((variant) => variant.seasonality === "none"),
    ).toHaveLength(768);
    expect(
      grid.filter((variant) => variant.seasonality === "day_of_week_match"),
    ).toHaveLength(768);
  });

  it("gives every seasonality variant a deterministic collision-free id", () => {
    const grid = buildStructureVariantGrid();
    expect(grid[0]).toMatchObject({
      id: "age7-p5-util70-hl7-support1-seasonality-none",
      seasonality: "none",
    });
    expect(grid[1]).toMatchObject({
      id: "age7-p5-util70-hl7-support1-seasonality-day_of_week_match",
      seasonality: "day_of_week_match",
    });
    expect(grid.at(-1)).toMatchObject({
      id: "age28-half_peer_p50-util95-hl56-support3-seasonality-day_of_week_match",
      seasonality: "day_of_week_match",
    });
  });

  it("explicitly eliminates annual modes that the 224-day history cannot estimate", () => {
    expect(H9_STRUCTURE_HISTORY_GRID.seasonalityModes).toEqual([
      "none",
      "day_of_week_match",
    ]);
    expect(H9_ANNUAL_SEASONALITY_ELIMINATION).toMatchObject({
      status: "eliminated",
      modes: ["month_of_year", "year_over_year"],
      historyLookbackDays: H9_STRUCTURE_HISTORY_LOOKBACK_DAYS,
      minimumAnnualCycleDays: 365,
      reason: H9_ANNUAL_SEASONALITY_ELIMINATION_REASON,
    });
    expect(H9_STRUCTURE_HISTORY_LOOKBACK_DAYS).toBeLessThan(
      H9_ANNUAL_SEASONALITY_ELIMINATION.minimumAnnualCycleDays,
    );
    expect(H9_ANNUAL_SEASONALITY_ELIMINATION_REASON).toContain("not estimable");
  });

  it("builds a fixed calendar-date cohort without timezone drift", () => {
    expect(
      buildFixedStructureOpportunityDates({
        startDate: "2026-04-22",
        endDate: "2026-05-14",
      }),
    ).toEqual(["2026-04-22", "2026-04-29", "2026-05-06", "2026-05-13"]);
  });

  it("keeps the declared Monday cadence phase when a clipped range starts mid-week", () => {
    expect(
      buildFixedStructureOpportunityDates({
        startDate: "2026-04-01",
        endDate: "2026-04-20",
        cadenceDays: 7,
        anchorDate: STRUCTURE_REPLAY_CADENCE_ANCHOR,
      }),
    ).toEqual(["2026-04-06", "2026-04-13", "2026-04-20"]);
  });

  it("uses fixed development, calibration, and locked-test boundaries per outcome window", () => {
    const protocol = buildStructureReplayProtocol({});
    expect(protocol.opportunityDates[0]).toBe("2025-12-01");
    expect(protocol.phases.development.opportunityDates.at(-1)).toBe(
      "2026-03-30",
    );
    expect(protocol.phases.calibration.opportunityDates[0]).toBe("2026-04-06");
    expect(protocol.phases.locked_test.opportunityDates).toEqual([
      "2026-06-01",
      "2026-06-08",
      "2026-06-15",
      "2026-06-22",
      "2026-06-29",
    ]);
    expect(protocol.phases.calibration.eligibleDatesByWindow[14].at(-1)).toBe(
      "2026-05-11",
    );
    expect(protocol.phases.locked_test.eligibleDatesByWindow[14].at(-1)).toBe(
      "2026-06-22",
    );
    expect(protocol.phases.locked_test.eligibleDatesByWindow[7].at(-1)).toBe(
      "2026-06-29",
    );
    expect(
      Object.keys(protocol.phases.locked_test.eligibleDatesByWindow),
    ).toEqual(STRUCTURE_OUTCOME_WINDOWS.map(String));
    expect(resolveStructureReplayPhase("2026-05-31")).toBe("calibration");
    expect(resolveStructureReplayPhase("2026-07-06")).toBeNull();
  });

  it("normalizes Meta minor-unit budgets and isolates goal identity", () => {
    expect(normalizeMetaBudgetMinorUnits(25_000)).toBe(250);
    expect(normalizeMetaBudgetMinorUnits(0)).toBeNull();
    expect(
      normalizeStructureGoalKey({
        customEventType: "PURCHASE",
        optimizationGoal: "Offsite Conversions",
        objective: "OUTCOME_SALES",
      }),
    ).toBe("event:purchase");
    expect(
      normalizeStructureGoalKey({ optimizationGoal: "Offsite Conversions" }),
    ).toBe("optimization:offsite_conversions");
  });

  it("isolates peer cohorts by grain, business, account, currency, goal, and date", () => {
    const base = {
      grain: "campaign" as const,
      businessId: "business-1",
      accountId: "account-1",
      currency: "usd",
      goalKey: "event:purchase",
      asOfDate: "2026-06-01",
    };
    const baseline = structurePeerCohortKey(base);
    expect(baseline).toBe(
      "campaign|business-1|account-1|USD|event:purchase|unknown|unknown|2026-06-01",
    );
    for (const candidate of [
      { ...base, grain: "adset" as const },
      { ...base, businessId: "business-2" },
      { ...base, accountId: "account-2" },
      { ...base, currency: "EUR" },
      { ...base, goalKey: "event:lead" },
      { ...base, cohort: "lead" as const },
      { ...base, bidRegime: "cost_cap" as const },
      { ...base, asOfDate: "2026-06-02" },
    ]) {
      expect(structurePeerCohortKey(candidate)).not.toBe(baseline);
    }
  });

  it("normalizes only cutoff-reconstructable bid regimes", () => {
    expect(
      normalizeStructureBidRegime({
        strategy: "LOWEST_COST_WITHOUT_CAP",
        value: null,
        valueFormat: null,
        mixed: false,
      }),
    ).toMatchObject({ regime: "lowest_cost", reconstructable: true });
    expect(
      normalizeStructureBidRegime({
        strategy: "LOWEST_COST_WITH_BID_CAP",
        value: 500,
        valueFormat: "minor_units",
        mixed: false,
      }),
    ).toMatchObject({ regime: "bid_cap", reconstructable: true });
    expect(
      normalizeStructureBidRegime({
        strategy: "LOWEST_COST_WITH_MIN_ROAS",
        value: 180,
        valueFormat: "roas_x100",
        mixed: false,
      }),
    ).toMatchObject({ regime: "minimum_roas", reconstructable: true });
    expect(
      normalizeStructureBidRegime({
        strategy: "COST_CAP",
        value: 2500,
        valueFormat: "minor_units",
        mixed: false,
      }),
    ).toMatchObject({ regime: "cost_cap", reconstructable: true });
    expect(
      normalizeStructureBidRegime({
        strategy: "COST_CAP",
        value: null,
        valueFormat: null,
        mixed: false,
      }),
    ).toMatchObject({ regime: "cost_cap", reconstructable: false });
    expect(
      normalizeStructureBidRegime({
        strategy: "BID_CAP",
        value: 500,
        valueFormat: "minor_units",
        mixed: true,
      }),
    ).toMatchObject({ regime: "unknown", reconstructable: false });
  });

  it("computes half-life weights and rejects invalid ages", () => {
    expect(structureRecencyWeight(0, 14)).toBe(1);
    expect(structureRecencyWeight(14, 14)).toBeCloseTo(0.5, 12);
    expect(structureRecencyWeight(28, 14)).toBeCloseTo(0.25, 12);
    expect(structureRecencyWeight(-1, 14)).toBeNull();
  });

  it("keeps none byte-equivalent in math to the legacy weighted history", () => {
    const facts = [
      { date: "2026-06-01", spend: 100, revenue: 400 },
      { date: "2026-06-08", spend: 100, revenue: 100 },
      { date: "2026-06-09", spend: 40, revenue: 800 },
    ];
    const legacy = facts.reduce(
      (totals, fact) => {
        const ageDays = differenceInStructureReplayDays(
          "2026-06-15",
          fact.date,
        );
        const weight = structureRecencyWeight(ageDays, 7)!;
        return {
          spend: totals.spend + Math.max(0, fact.spend) * weight,
          revenue: totals.revenue + Math.max(0, fact.revenue) * weight,
        };
      },
      { spend: 0, revenue: 0 },
    );

    expect(
      calculateStructureWeightedRoas({
        facts,
        startDate: "2026-06-01",
        asOfDate: "2026-06-15",
        halfLifeDays: 7,
        seasonality: "none",
      }),
    ).toBe(legacy.revenue / legacy.spend);
  });

  it("uses same-weekday facts only and keeps exponential weights inside that set", () => {
    const facts = [
      { date: "2026-06-01", spend: 100, revenue: 400 },
      { date: "2026-06-08", spend: 100, revenue: 100 },
      { date: "2026-06-09", spend: 100, revenue: 10_000 },
    ];
    expect(
      structureHistoryFactMatchesSeasonality({
        asOfDate: "2026-06-15",
        factDate: "2026-06-08",
        seasonality: "day_of_week_match",
      }),
    ).toBe(true);
    expect(
      structureHistoryFactMatchesSeasonality({
        asOfDate: "2026-06-15",
        factDate: "2026-06-09",
        seasonality: "day_of_week_match",
      }),
    ).toBe(false);
    expect(
      calculateStructureWeightedRoas({
        facts,
        startDate: "2026-06-01",
        asOfDate: "2026-06-15",
        halfLifeDays: 7,
        seasonality: "day_of_week_match",
      }),
    ).toBe(2);
  });

  it("computes non-purchase cost per result without substituting a ROAS target", () => {
    const metrics = calculateStructureWeightedMetrics({
      facts: [
        { date: "2026-06-01", spend: 100, revenue: 0, conversions: 10 },
        { date: "2026-06-08", spend: 50, revenue: 0, conversions: 5 },
      ],
      startDate: "2026-06-01",
      asOfDate: "2026-06-08",
      halfLifeDays: 7,
      seasonality: "none",
    });
    expect(metrics.roas).toBe(0);
    expect(metrics.costPerResult).toBe(10);
  });

  it("keys same-half-life history signals by seasonality without collisions", () => {
    const noneKey = structureHistorySignalKey({
      halfLifeDays: 28,
      seasonality: "none",
    });
    const weekdayKey = structureHistorySignalKey({
      halfLifeDays: 28,
      seasonality: "day_of_week_match",
    });
    expect(noneKey).not.toBe(weekdayKey);

    const row = opportunity({
      history: {
        [noneKey]: {
          weightedRoas: 3,
          weightedCostPerResult: 10,
          peerRoasP75: 2.5,
          peerCostPerResultP25: 12,
          peerWinnerPurchaseP50: 24,
          peerWinnerOutcomeCountP50: 24,
          consecutiveSupportDays: 3,
          peerCount: 5,
        },
        [weekdayKey]: {
          weightedRoas: 2,
          weightedCostPerResult: 15,
          peerRoasP75: 2.5,
          peerCostPerResultP25: 12,
          peerWinnerPurchaseP50: 24,
          peerWinnerOutcomeCountP50: 24,
          consecutiveSupportDays: 3,
          peerCount: 5,
        },
      },
    });
    expect(evaluateStructureCandidate(row, baselineVariant).candidate).toBe(
      true,
    );
    expect(
      evaluateStructureCandidate(row, {
        ...baselineVariant,
        seasonality: "day_of_week_match",
      }),
    ).toMatchObject({
      candidate: false,
      reasonCodes: expect.arrayContaining([
        "history_below_purchase_scale_floor",
      ]),
    });
  });
});

describe("structure replay authority", () => {
  it("infers ad-set ownership only from cutoff config and fails closed without it", () => {
    expect(
      resolveStructureBudgetOwner({
        campaignConfigAvailable: true,
        campaignDailyBudget: null,
        campaignBudgetMixed: true,
        adsetConfigAvailable: true,
        adsetDailyBudget: 10_000,
      }),
    ).toMatchObject({ owner: "adset", reconstructable: true });
    expect(
      resolveStructureBudgetOwner({
        campaignConfigAvailable: false,
        campaignDailyBudget: null,
        campaignBudgetMixed: false,
        adsetConfigAvailable: true,
        adsetDailyBudget: 10_000,
      }),
    ).toMatchObject({ owner: "unknown", reconstructable: false });
  });

  it("does not grant campaign execution authority from collapsed effective budgets", () => {
    expect(
      resolveStructureBudgetOwner({
        campaignConfigAvailable: true,
        campaignDailyBudget: 10_000,
        campaignBudgetMixed: false,
      }),
    ).toMatchObject({
      owner: "campaign",
      reconstructable: false,
      reason: "effective_budget_could_be_campaign_or_equal_adset_fallback",
    });
  });

  it("keeps a mathematically qualified candidate review-only when status is not historical", () => {
    const result = evaluateStructureCandidate(opportunity(), baselineVariant);
    expect(result).toMatchObject({
      candidate: true,
      action: "increase_campaign_budget",
      authority: "review_only",
    });
    expect(result.reasonCodes).toContain(
      "historical_status_execution_authority_unproven",
    );
  });

  it("fails purchase scale closed without fresh cutoff-safe economics", () => {
    const result = evaluateStructureCandidate(
      opportunity({ targetFresh: false }),
      baselineVariant,
    );
    expect(result.candidate).toBe(false);
    expect(result.reasonCodes).toContain("fresh_purchase_economics_missing");
  });

  it("evaluates a lead cohort from primary-result efficiency without a ROAS target", () => {
    const result = evaluateStructureCandidate(
      opportunity({
        cohort: "lead",
        purchaseCohort: false,
        targetCutoffSafe: false,
        targetFresh: false,
        targetRoas: null,
        breakEvenRoas: null,
        cumulativePurchases: 0,
        cumulativeConversions: 20,
        history: {
          [baselineHistoryKey]: {
            weightedRoas: null,
            weightedCostPerResult: 8,
            peerRoasP75: null,
            peerCostPerResultP25: 10,
            peerWinnerPurchaseP50: null,
            peerWinnerOutcomeCountP50: 24,
            consecutiveSupportDays: 3,
            peerCount: 5,
          },
        },
      }),
      baselineVariant,
    );
    expect(result.candidate).toBe(true);
    expect(result.reasonCodes).not.toContain(
      "fresh_purchase_economics_missing",
    );
  });

  it("uses half the peer-winner purchase median without a fixed fallback", () => {
    const result = evaluateStructureCandidate(
      opportunity({ cumulativePurchases: 11 }),
      { ...baselineVariant, purchaseThreshold: "half_peer_winner_p50" },
    );
    expect(result.requiredPurchases).toBe(12);
    expect(result.candidate).toBe(false);

    const missingPeer = evaluateStructureCandidate(
      opportunity({
        history: {
          [baselineHistoryKey]: {
            weightedRoas: 3,
            weightedCostPerResult: 10,
            peerRoasP75: 2.5,
            peerCostPerResultP25: 12,
            peerWinnerPurchaseP50: null,
            peerWinnerOutcomeCountP50: null,
            consecutiveSupportDays: 3,
            peerCount: 5,
          },
        },
      }),
      { ...baselineVariant, purchaseThreshold: "half_peer_winner_p50" },
    );
    expect(missingPeer.requiredPurchases).toBeNull();
    expect(missingPeer.candidate).toBe(false);
  });

  it("never crosses campaign and ad-set action grains", () => {
    const result = evaluateStructureCandidate(
      opportunity({ grain: "adset", budgetOwner: "campaign" }),
      baselineVariant,
    );
    expect(result).toMatchObject({ candidate: false, action: "none" });
    expect(result.reasonCodes).toContain("grain_is_not_inferred_budget_owner");
  });
});

describe("structure durability outcomes and paired scoring", () => {
  it("requires complete account-day receipts before closing an outcome", () => {
    expect(
      classifyStructureDurabilityOutcome({
        completeReceipt: false,
        futureSpend: 100,
        futurePurchases: 10,
        futureRoas: 4,
        peerCount: 5,
        peerRoasP25: 1,
        peerRoasP50: 2,
        peerRoasP75: 3,
        peerSpendP50: 100,
      }),
    ).toEqual({ status: "unknown", criticalRefutation: false });
  });

  it("separates durable winners, critical refutations, neutral rows, and censoring", () => {
    const base = {
      completeReceipt: true,
      futureSpend: 100,
      futurePurchases: 10,
      futureRoas: 4,
      targetRoas: 3,
      breakEvenRoas: 1.5,
      peerCount: 5,
      peerRoasP25: 1,
      peerRoasP50: 2,
      peerRoasP75: 3,
      peerSpendP50: 80,
    };
    expect(classifyStructureDurabilityOutcome(base).status).toBe("supported");
    expect(
      classifyStructureDurabilityOutcome({
        ...base,
        futurePurchases: 0,
        futureRoas: 0,
      }),
    ).toEqual({ status: "refuted", criticalRefutation: true });
    expect(
      classifyStructureDurabilityOutcome({ ...base, futureRoas: 2.5 }).status,
    ).toBe("neutral");
    expect(
      classifyStructureDurabilityOutcome({ ...base, futureSpend: 0 }).status,
    ).toBe("censored");
  });

  it("classifies non-purchase durability by peer cost per result only", () => {
    const base = {
      completeReceipt: true,
      cohort: "lead" as const,
      futureSpend: 100,
      futurePurchases: 0,
      futureConversions: 20,
      futureRoas: 0,
      futureCostPerResult: 5,
      peerCount: 5,
      peerRoasP25: null,
      peerRoasP50: null,
      peerRoasP75: null,
      peerCostPerResultP25: 6,
      peerCostPerResultP50: 10,
      peerCostPerResultP75: 14,
      peerSpendP50: 80,
    };
    expect(classifyStructureDurabilityOutcome(base).status).toBe("supported");
    expect(
      classifyStructureDurabilityOutcome({
        ...base,
        futureConversions: 0,
        futureCostPerResult: null,
      }),
    ).toEqual({ status: "refuted", criticalRefutation: true });
  });

  it("scores every variant against the same opportunity denominator", () => {
    const rows = [
      opportunity({ entityId: "supported", outcome: "supported" }),
      opportunity({
        entityId: "refuted",
        outcome: "refuted",
        criticalRefutation: true,
      }),
      opportunity({
        entityId: "missed",
        outcome: "supported",
        budgetUtilization: 0.5,
      }),
      opportunity({
        entityId: "wrong-owner",
        budgetOwner: "adset",
        outcome: "refuted",
      }),
    ];
    const score = scoreStructureVariant(rows, baselineVariant);
    expect(score).toMatchObject({
      fixedCohortSize: 4,
      scoreableCohortSize: 3,
      candidateCount: 2,
      supportedCandidates: 1,
      refutedCandidates: 1,
      falseNegative: 1,
      precision: 0.5,
      opportunityRecall: 0.5,
      criticalFalsePositiveRate: 0.5,
    });
  });

  it("hashes the fixed cohort independently of input ordering", () => {
    const left = opportunity({ entityId: "left" });
    const right = opportunity({ entityId: "right" });
    expect(hashFixedStructureCohort([left, right])).toBe(
      hashFixedStructureCohort([right, left]),
    );
  });
});
