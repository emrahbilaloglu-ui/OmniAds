import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateCut,
  resolvePublishedCutState,
  shouldHoldForRecentRecovery,
  summarizeWindow,
  VARIANTS,
  type DailyCandidateRow,
  type Episode,
} from "@/scripts/creative-decision-center/f1-f2-cut-threshold-sweep";

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    variantId: "V0_current",
    business: {
      id: "business-1",
      name: "Business 1",
      providerAccountId: "act_1",
    },
    asOfDate: "2026-01-01",
    creativeId: "creative-1",
    creativeName: null,
    campaignId: "campaign-1",
    source: "ratio_loss_budget",
    spend28: 100,
    purchases28: 1,
    roas28: 0.5,
    recent7Spend: 10,
    recent7Roas: 0.5,
    targetRoas: 2,
    breakEvenRoas: 1.5,
    forward14Spend: 20,
    forward14Roas: 0,
    forward28Spend: 30,
    forward28Roas: 0,
    spendUnit: 10,
    lossBudgetMultiplier: 2,
    hardCutMultiplier: 4,
    boundary: 0.7,
    purchaseFloor: null,
    purchaseFloorUsedFallback: false,
    lossBudgetGeHardCut: false,
    boundaryFallbackReason: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<DailyCandidateRow> = {}): DailyCandidateRow {
  return {
    business: {
      id: "business-1",
      name: "Business 1",
      providerAccountId: "act_1",
    },
    asOfDate: "2026-01-10",
    creativeId: "creative-1",
    creativeName: "Creative 1",
    campaignId: "campaign-1",
    effectiveStatus: "ACTIVE",
    ageDays: 30,
    asOfDateSpend: 10,
    spend28: 1_000,
    purchases28: 5,
    revenue28: 1_200,
    roas28: 1.2,
    recent7Spend: 100,
    recent7Roas: 1.6,
    forward14Spend: 100,
    forward14Revenue: 100,
    forward14Roas: 1,
    forward28Spend: 200,
    forward28Revenue: 200,
    forward28Roas: 1,
    targetRoas: 2,
    breakEvenRoas: 1.5,
    targetCpa: 10,
    operatorAovAssumption: null,
    accountCpaP50: 10,
    accountCpaSampleCount: 30,
    metaAovMean90d: 30,
    metaAovPurchaseCount90d: 100,
    metaRevenue90d: 3_000,
    matureCreativeCount: 30,
    matureSpendP50: 100,
    winnerPurchaseP50: 10,
    roasRatioP10: 0.2,
    roasRatioP25: 0.3,
    preset: "balanced",
    attributionAovAdjustmentMultiplier: 1,
    ...overrides,
  };
}

function variant(id: string) {
  const found = VARIANTS.find((item) => item.id === id);
  if (!found) throw new Error(`Missing test variant ${id}`);
  return found;
}

describe("F1/F2 forward outcome summarization", () => {
  it("treats finite zero ROAS with positive spend as a known loser", () => {
    expect(summarizeWindow([episode()], 14)).toEqual({
      knownEpisodes: 1,
      unknownEpisodes: 0,
      recoveredAboveTarget: 0,
      earlyCutRate: 0,
      trueLoserEpisodes: 1,
      savedSpend: 20,
      savedSpendUnits: 2,
    });
  });

  it("keeps missing ROAS and zero forward spend censored", () => {
    const summary = summarizeWindow(
      [episode({ forward14Roas: null }), episode({ creativeId: "creative-2", forward14Spend: 0 })],
      14,
    );

    expect(summary.knownEpisodes).toBe(0);
    expect(summary.unknownEpisodes).toBe(2);
  });
});

describe("mature below-break-even recovery challengers", () => {
  it("holds V2c at break-even while V2b still cuts below target", () => {
    const row = candidate({ recent7Roas: 1.5 });

    expect(evaluateCut(row, variant("V2b_p25_breakeven_floor"))).toMatchObject({
      cuts: true,
      source: "ratio_hard_cut",
    });
    expect(evaluateCut(row, variant("V2c_breakeven_recent_hold"))).toMatchObject({
      cuts: false,
      blockedReason: "recent_recovery_hold",
    });
  });

  it("requires a sufficient recent-spend sample before the V2c hold", () => {
    expect(
      shouldHoldForRecentRecovery({
        mode: "breakeven",
        targetRoas: 2,
        breakEvenRoas: 1.5,
        recent7Spend: 9.99,
        recentSampleMinSpend: 10,
        recent7Roas: 2,
      }),
    ).toBe(false);
    expect(
      shouldHoldForRecentRecovery({
        mode: "breakeven",
        targetRoas: 2,
        breakEvenRoas: 1.5,
        recent7Spend: 10,
        recentSampleMinSpend: 10,
        recent7Roas: 1.5,
      }),
    ).toBe(true);
  });

  it("keeps zero-conversion safety eligible when ROAS is finite zero", () => {
    expect(
      evaluateCut(
        candidate({
          purchases28: 0,
          revenue28: 0,
          roas28: 0,
          recent7Roas: 0,
        }),
        variant("V2c_breakeven_recent_hold"),
      ),
    ).toMatchObject({ cuts: true, source: "zero_conv_burner" });
  });
});

describe("V2d later-calendar-date confirmation", () => {
  it("publishes a ratio cut only on the next consecutive calendar date", () => {
    expect(
      resolvePublishedCutState({
        confirmationMode: "later_calendar_date_consecutive",
        currentDate: "2026-01-10",
        currentRawCuts: true,
        currentSource: "ratio_loss_budget",
        previousDate: null,
        previousRawCuts: false,
        previousPublishedCuts: false,
      }),
    ).toEqual({ cuts: false, pending: true });
    expect(
      resolvePublishedCutState({
        confirmationMode: "later_calendar_date_consecutive",
        currentDate: "2026-01-11",
        currentRawCuts: true,
        currentSource: "ratio_loss_budget",
        previousDate: "2026-01-10",
        previousRawCuts: true,
        previousPublishedCuts: false,
      }),
    ).toEqual({ cuts: true, pending: false });
  });

  it("does not let a same-day retry or a date gap manufacture confirmation", () => {
    for (const currentDate of ["2026-01-10", "2026-01-12"]) {
      expect(
        resolvePublishedCutState({
          confirmationMode: "later_calendar_date_consecutive",
          currentDate,
          currentRawCuts: true,
          currentSource: "ratio_hard_cut",
          previousDate: "2026-01-10",
          previousRawCuts: true,
          previousPublishedCuts: false,
        }),
      ).toEqual({ cuts: false, pending: true });
    }
  });

  it.each(["zero_conv_burner", "maturity_severe_loser"] as const)(
    "keeps %s immediate",
    (source) => {
      expect(
        resolvePublishedCutState({
          confirmationMode: "later_calendar_date_consecutive",
          currentDate: "2026-01-10",
          currentRawCuts: true,
          currentSource: source,
          previousDate: null,
          previousRawCuts: false,
          previousPublishedCuts: false,
        }),
      ).toEqual({ cuts: true, pending: false });
    },
  );
});

describe("live replay safety contract", () => {
  const source = readFileSync(
    "scripts/creative-decision-center/f1-f2-cut-threshold-sweep.ts",
    "utf8",
  );

  it("uses one explicit repeatable-read read-only transaction with rollback", () => {
    expect(source).toContain(
      '"BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"',
    );
    expect(source).toContain(
      'await client.query("SET LOCAL statement_timeout = \'30s\'")',
    );
    expect(source).toContain('await client.query("ROLLBACK")');
    expect(source).not.toContain('client.query("COMMIT")');
    expect(source).toContain("startDate: addDays(startDate, -2)");
  });

  it.each([
    "act_1087566732415606",
    "act_1054905059780305",
    "act_805150454596350",
    "act_822913786458311",
  ])("pins requested account %s", (accountId) => {
    expect(source).toContain(accountId);
  });
});
