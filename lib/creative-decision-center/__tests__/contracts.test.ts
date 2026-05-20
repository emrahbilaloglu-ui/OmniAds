import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS,
  CREATIVE_DECISION_CENTER_BUYER_ACTIONS,
  CREATIVE_DECISION_CENTER_EXECUTION_ACTIONS,
  CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
  CREATIVE_DECISION_OS_V21_CONTRACT_VERSION,
  CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS,
  type BuyerActionMappingRule,
  type CreativeDecisionCenterBuyerAction,
  type CreativeDecisionCenterExecutionAction,
  type CreativeDecisionCenterRowDecision,
  type CreativeDecisionOsV21Output,
  type DecisionCenterSnapshot,
} from "../contracts";

describe("Creative Decision Center V2.1 contracts", () => {
  it("freezes contract version literals", () => {
    expect(CREATIVE_DECISION_OS_V21_CONTRACT_VERSION).toBe(
      "creative-decision-os.v2.1",
    );
    expect(CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION).toBe(
      "creative-decision-center.v2.1",
    );
    expectTypeOf<CreativeDecisionOsV21Output["contractVersion"]>().toEqualTypeOf<
      typeof CREATIVE_DECISION_OS_V21_CONTRACT_VERSION
    >();
    expectTypeOf<DecisionCenterSnapshot["contractVersion"]>().toEqualTypeOf<
      typeof CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION
    >();
  });

  it("keeps primary decisions separate from buyer actions", () => {
    expect(CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS).toEqual([
      "Scale",
      "Cut",
      "Refresh",
      "Protect",
      "Test More",
      "Diagnose",
    ]);
    expect(CREATIVE_DECISION_CENTER_BUYER_ACTIONS).toEqual([
      "scale",
      "cut",
      "refresh",
      "protect",
      "test_more",
      "watch_launch",
      "fix_delivery",
      "fix_policy",
      "diagnose_data",
    ]);
    expectTypeOf<CreativeDecisionOsV21Output["primaryDecision"]>().not.toEqualTypeOf<
      CreativeDecisionCenterBuyerAction
    >();
  });

  it("keeps brief_variation aggregate-only", () => {
    expect(CREATIVE_DECISION_CENTER_BUYER_ACTIONS).not.toContain(
      "brief_variation" as never,
    );
    expect(CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS).toContain(
      "brief_variation",
    );
    expectTypeOf<CreativeDecisionCenterRowDecision["buyerAction"]>().not.toEqualTypeOf<
      "brief_variation"
    >();
  });

  it("keeps queue/apply eligibility false-only in the engine contract", () => {
    expectTypeOf<CreativeDecisionOsV21Output["queueEligible"]>().toEqualTypeOf<false>();
    expectTypeOf<CreativeDecisionOsV21Output["applyEligible"]>().toEqualTypeOf<false>();
  });

  it("exposes executionAction as an optional, nullable row field disjoint from buyerAction", () => {
    expect(CREATIVE_DECISION_CENTER_EXECUTION_ACTIONS).toEqual([
      "promote_to_main",
      "scale_budget",
      "controlled_scale",
    ]);
    expect(CREATIVE_DECISION_CENTER_BUYER_ACTIONS).not.toContain(
      "promote_to_main" as never,
    );
    expect(CREATIVE_DECISION_CENTER_BUYER_ACTIONS).not.toContain(
      "scale_budget" as never,
    );
    expect(CREATIVE_DECISION_CENTER_BUYER_ACTIONS).not.toContain(
      "controlled_scale" as never,
    );
    expectTypeOf<CreativeDecisionCenterRowDecision["executionAction"]>().toEqualTypeOf<
      CreativeDecisionCenterExecutionAction | null | undefined
    >();
    expectTypeOf<
      NonNullable<CreativeDecisionCenterRowDecision["executionAction"]>
    >().not.toEqualTypeOf<CreativeDecisionCenterBuyerAction>();
    expectTypeOf<BuyerActionMappingRule["output"]["executionAction"]>().toEqualTypeOf<
      CreativeDecisionCenterExecutionAction | null | undefined
    >();
  });

  it("keeps sourceDecision as opaque audit metadata and not a typed primary decision", () => {
    expectTypeOf<CreativeDecisionCenterRowDecision["sourceDecision"]>().toEqualTypeOf<
      string | null | undefined
    >();
    expectTypeOf<CreativeDecisionCenterRowDecision["sourceDecision"]>().not.toMatchTypeOf<
      CreativeDecisionOsV21Output["primaryDecision"]
    >();
  });
});
