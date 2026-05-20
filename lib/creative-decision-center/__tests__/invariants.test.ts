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

  // PR6A intentionally keeps the contract structural-only: executionAction is
  // validated as a literal/null/undefined membership but no cross-field policy
  // ties it to buyerAction. The cross-field invariant
  //   executionAction != null  =>  buyerAction === "scale"
  // is owned by the PR6B adapter together with the runtime guard recommended
  // by the media-buyer review (no `promote_to_main` UI default for unlabeled
  // scale rows). Tracking the deferral here so it appears in the test
  // transcript instead of staying implicit.
  it.todo(
    "I22:executionAction_only_with_scale_buyerAction — enforced by PR6B adapter, not by PR6A contract",
  );
});
