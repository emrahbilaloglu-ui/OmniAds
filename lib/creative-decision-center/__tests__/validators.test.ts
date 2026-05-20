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

  it("accepts optional executionAction values and rejects unknown literals", () => {
    expect(
      validateCreativeDecisionCenterRowDecision({
        ...makeRowDecision({ buyerAction: "scale", uiBucket: "scale" }),
        executionAction: "promote_to_main",
      }),
    ).toEqual({ ok: true, errors: [] });

    expect(
      validateCreativeDecisionCenterRowDecision({
        ...makeRowDecision(),
        executionAction: null,
      }),
    ).toEqual({ ok: true, errors: [] });

    expect(
      validateCreativeDecisionCenterRowDecision({
        ...makeRowDecision(),
        executionAction: undefined,
      }),
    ).toEqual({ ok: true, errors: [] });

    expect(
      validateCreativeDecisionCenterRowDecision({
        ...makeRowDecision(),
        executionAction: "review",
      }).errors,
    ).toContain("rowDecision.executionAction:invalid_literal:review");
  });

  it("accepts optional sourceDecision metadata and rejects non-string values", () => {
    expect(
      validateCreativeDecisionCenterRowDecision({
        ...makeRowDecision(),
        sourceDecision: "keep",
      }),
    ).toEqual({ ok: true, errors: [] });

    expect(
      validateCreativeDecisionCenterRowDecision({
        ...makeRowDecision(),
        sourceDecision: null,
      }),
    ).toEqual({ ok: true, errors: [] });

    expect(
      validateCreativeDecisionCenterRowDecision({
        ...makeRowDecision(),
        sourceDecision: 42,
      }).errors,
    ).toContain("rowDecision.sourceDecision:invalid_type:expected_string");

    expect(
      validateCreativeDecisionCenterRowDecision({
        ...makeRowDecision(),
        sourceDecision: { foo: 1 },
      }).errors,
    ).toContain("rowDecision.sourceDecision:invalid_type:expected_string");

    expect(
      validateCreativeDecisionCenterRowDecision({
        ...makeRowDecision(),
        sourceDecision: true,
      }).errors,
    ).toContain("rowDecision.sourceDecision:invalid_type:expected_string");
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

  it("accepts optional executionAction on mapping rule output and rejects unknown literals", () => {
    expect(
      validateBuyerActionMappingRule({
        id: "scale-test-cohort",
        when: { primaryDecision: "Scale" },
        output: {
          buyerAction: "scale",
          buyerLabel: "Scale",
          uiBucket: "scale",
          executionAction: "promote_to_main",
          nextStepTemplate: "Promote winner into Main lane.",
        },
      }),
    ).toEqual({ ok: true, errors: [] });

    expect(
      validateBuyerActionMappingRule({
        id: "scale-execution-null",
        when: { primaryDecision: "Scale" },
        output: {
          buyerAction: "scale",
          buyerLabel: "Scale",
          uiBucket: "scale",
          executionAction: null,
          nextStepTemplate: "Hold for structure review.",
        },
      }),
    ).toEqual({ ok: true, errors: [] });

    expect(
      validateBuyerActionMappingRule({
        id: "scale-invalid-execution",
        when: { primaryDecision: "Scale" },
        output: {
          buyerAction: "scale",
          buyerLabel: "Scale",
          uiBucket: "scale",
          executionAction: "scale_budget_in_main",
          nextStepTemplate: "Scale budget.",
        },
      }).errors,
    ).toContain(
      "mappingRule.output.executionAction:invalid_literal:scale_budget_in_main",
    );
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
