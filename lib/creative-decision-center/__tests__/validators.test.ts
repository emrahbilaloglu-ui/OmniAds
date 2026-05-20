import { describe, expect, it } from "vitest";
import {
  createEmptyActionBoard,
  validateBuyerActionMappingRule,
  validateCreativeDecisionCenterAggregateDecision,
  validateCreativeDecisionCenterRowDecision,
  validateCreativeDecisionConfig,
  validateCreativeDecisionOsV21Output,
  validateDecisionCenterSnapshot,
} from "../validators";
import { makeAggregateDecision, makeEngine, makeRowDecision, makeSnapshot } from "./helpers";

describe("Creative Decision Center V2.1 structural validators", () => {
  it("accepts valid engine outputs and rejects structural engine violations", () => {
    expect(validateCreativeDecisionOsV21Output(makeEngine())).toEqual({
      ok: true,
      errors: [],
    });

    expect(validateCreativeDecisionOsV21Output({ ...makeEngine(), engineVersion: "" }).errors)
      .toContain("engine.engineVersion:empty_string");
    expect(
      validateCreativeDecisionOsV21Output({
        ...makeEngine(),
        primaryDecision: "Foo",
      }).errors,
    ).toContain("engine.primaryDecision:invalid_literal:Foo");
    expect(
      validateCreativeDecisionOsV21Output({
        ...makeEngine(),
        queueEligible: true,
      }).errors,
    ).toContain("engine.queueEligible:eligibility_flag_must_be_false");
  });

  it("accepts valid row decisions and rejects aggregate-only row actions", () => {
    expect(validateCreativeDecisionCenterRowDecision(makeRowDecision())).toEqual({
      ok: true,
      errors: [],
    });

    expect(
      validateCreativeDecisionCenterRowDecision({
        ...makeRowDecision(),
        buyerAction: "brief_variation",
      }).errors,
    ).toEqual(
      expect.arrayContaining([
        "rowDecision.buyerAction:aggregate_only:brief_variation",
        "rowDecision.buyerAction:invalid_literal:brief_variation",
      ]),
    );
  });

  it("keeps brief_variation valid only on aggregate decisions", () => {
    expect(
      validateCreativeDecisionCenterAggregateDecision(makeAggregateDecision()),
    ).toEqual({ ok: true, errors: [] });
  });

  it("validates complete decisionCenter snapshots and required top-level fields", () => {
    expect(validateDecisionCenterSnapshot(makeSnapshot())).toEqual({
      ok: true,
      errors: [],
    });

    const withoutAdapterVersion = { ...makeSnapshot() };
    delete (withoutAdapterVersion as Partial<typeof withoutAdapterVersion>).adapterVersion;

    expect(validateDecisionCenterSnapshot(withoutAdapterVersion).errors).toContain(
      "snapshot.adapterVersion:missing_key",
    );
  });

  it("requires every actionBoard buyer action key", () => {
    const actionBoard = createEmptyActionBoard();
    delete (actionBoard as Partial<typeof actionBoard>).fix_policy;

    expect(validateDecisionCenterSnapshot(makeSnapshot({ actionBoard })).errors).toContain(
      "snapshot.actionBoard.fix_policy:missing_key",
    );
  });

  it("validates mapping rules structurally without computing buyerAction", () => {
    expect(
      validateBuyerActionMappingRule({
        id: "diagnose-missing-data",
        when: {
          primaryDecision: "Diagnose",
          problemClass: "data_quality",
          reasonTagsAny: ["missing_truth"],
          actionability: "diagnose",
          requiredData: ["truth"],
          blockersAbsent: ["policy"],
        },
        output: {
          buyerAction: "diagnose_data",
          buyerLabel: "Diagnose data",
          uiBucket: "diagnose_data",
          nextStepTemplate: "Resolve missing data.",
        },
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  it("validates config shape without providing default config values", () => {
    expect(
      validateCreativeDecisionConfig({
        configVersion: "test-config",
        launchWindowHours: 72,
        noSpendWindowHours: 24,
        minSpendForMaturityMultiplier: 2,
        minPurchasesForScale: 3,
        minImpressionsForCtrReliability: 1000,
        fatigueCtrDropPct: 25,
        fatigueCpmIncreasePct: 20,
        fatigueFrequencyIncreasePct: 15,
        maxCpaOverTargetForCut: 1.3,
        minRoasOverTargetForScale: 1.2,
        winnerGapDays: 14,
        fatigueClusterTopN: 5,
        benchmarkReliabilityMinimum: "medium",
        staleDataHours: 24,
        minConfidenceForScale: 70,
        minConfidenceForCut: 70,
      }),
    ).toEqual({ ok: true, errors: [] });
  });
});
