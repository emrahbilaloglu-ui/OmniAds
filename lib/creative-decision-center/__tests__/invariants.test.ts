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
});
