import { describe, expect, it } from "vitest";
import {
  auditCreativeDecisionCenterAggregateInvariants,
  auditCreativeDecisionCenterRowInvariants,
  auditDecisionCenterSnapshotInvariants,
} from "../invariants";
import type {
  CreativeDecisionCenterAggregateDecision,
  CreativeDecisionCenterRowDecision,
} from "../contracts";
import { makeAggregateDecision, makeRowDecision, makeSnapshot } from "./helpers";

describe("Creative Decision Center V2.1 invariant audit helpers", () => {
  it("returns violations without throwing or rejecting structural validation", () => {
    const row = makeRowDecision({
      confidenceBand: "high",
      missingData: ["target"],
    });

    expect(auditCreativeDecisionCenterRowInvariants(row)).toEqual([
      {
        id: "I20:missing_data_with_high_confidence",
        path: "rowDecision",
        message: "Rows with missing required data must diagnose or cap confidence.",
      },
    ]);
  });

  it("reports row-level brief_variation only as an audit violation", () => {
    const row = {
      ...makeRowDecision({ missingData: [], engine: { ...makeRowDecision().engine, missingData: [] } }),
      buyerAction: "brief_variation",
    } as unknown as CreativeDecisionCenterRowDecision;

    expect(auditCreativeDecisionCenterRowInvariants(row)).toEqual([
      {
        id: "I04:row_level_brief_variation",
        path: "rowDecision",
        message: "brief_variation is aggregate-only and must not appear on row decisions.",
      },
    ]);
  });

  it("reports aggregate decisions carrying creativeId as audit violations", () => {
    const aggregate = {
      ...makeAggregateDecision(),
      creativeId: "creative_1",
    } as unknown as CreativeDecisionCenterAggregateDecision;

    expect(auditCreativeDecisionCenterAggregateInvariants(aggregate)).toEqual([
      {
        id: "I21:aggregate_decision_attached_to_creative_id",
        path: "aggregateDecision",
        message: "Aggregate decisions must not attach to a random creativeId.",
      },
    ]);
  });

  it("audits snapshots by collecting row and aggregate violations", () => {
    const snapshot = makeSnapshot({
      rowDecisions: [
        makeRowDecision({
          confidenceBand: "high",
          missingData: ["truth"],
        }),
      ],
      aggregateDecisions: [
        {
          ...makeAggregateDecision(),
          creativeId: "creative_1",
        } as unknown as CreativeDecisionCenterAggregateDecision,
      ],
    });

    expect(auditDecisionCenterSnapshotInvariants(snapshot).map((violation) => violation.id))
      .toEqual([
        "I20:missing_data_with_high_confidence",
        "I21:aggregate_decision_attached_to_creative_id",
      ]);
  });

  // I22 (D019): executionAction is row-level metadata tied to scale verdicts.
  // PR6B promoted the cross-field check from a deferred todo to a real audit
  // rule so any row decision constructed by future adapters surfaces the
  // violation immediately.
  it("flags executionAction on non-scale rows as I22 violations", () => {
    const cutRow = {
      ...makeRowDecision({ buyerAction: "cut", uiBucket: "cut" }),
      executionAction: "promote_to_main",
    } as unknown as CreativeDecisionCenterRowDecision;

    expect(
      auditCreativeDecisionCenterRowInvariants(cutRow).map((violation) => violation.id),
    ).toEqual(["I22:execution_action_outside_scale_buyer_action"]);
  });

  it.each([
    "cut",
    "refresh",
    "protect",
    "test_more",
    "watch_launch",
    "fix_delivery",
    "fix_policy",
    "diagnose_data",
  ] as const)(
    "flags forced executionAction on %s row as I22 violation",
    (buyerAction) => {
      const row = {
        ...makeRowDecision({
          buyerAction,
          uiBucket: buyerAction,
          missingData: [],
          engine: { ...makeRowDecision().engine, missingData: [] },
        }),
        executionAction: "scale_budget",
      } as unknown as CreativeDecisionCenterRowDecision;

      expect(
        auditCreativeDecisionCenterRowInvariants(row).map((violation) => violation.id),
      ).toEqual(["I22:execution_action_outside_scale_buyer_action"]);
    },
  );

  it("collects both I20 and I22 when a non-scale row carries missing data + executionAction at high confidence", () => {
    const row = {
      ...makeRowDecision({
        buyerAction: "cut",
        uiBucket: "cut",
        confidenceBand: "high",
        missingData: ["truth"],
      }),
      executionAction: "promote_to_main",
    } as unknown as CreativeDecisionCenterRowDecision;

    expect(
      auditCreativeDecisionCenterRowInvariants(row).map((violation) => violation.id),
    ).toEqual([
      "I20:missing_data_with_high_confidence",
      "I22:execution_action_outside_scale_buyer_action",
    ]);
  });

  it("keeps scale rows with executionAction clean of I22", () => {
    const scaleRow = {
      ...makeRowDecision({
        buyerAction: "scale",
        uiBucket: "scale",
        missingData: [],
        engine: { ...makeRowDecision().engine, missingData: [] },
      }),
      executionAction: "scale_budget",
    } as unknown as CreativeDecisionCenterRowDecision;

    expect(auditCreativeDecisionCenterRowInvariants(scaleRow)).toEqual([]);
  });

  it("keeps non-scale rows with null/undefined executionAction clean of I22", () => {
    const refreshNullRow = {
      ...makeRowDecision({
        buyerAction: "refresh",
        uiBucket: "refresh",
        missingData: [],
        engine: { ...makeRowDecision().engine, missingData: [] },
      }),
      executionAction: null,
    } as unknown as CreativeDecisionCenterRowDecision;

    expect(auditCreativeDecisionCenterRowInvariants(refreshNullRow)).toEqual([]);
  });
});
