import { describe, expect, it } from "vitest";
import {
  buildDecisionCenterObservabilityEvents,
  CREATIVE_DECISION_CENTER_OBSERVABILITY_VERSION,
  DECISION_CENTER_OBSERVABILITY_LOG_MARKER,
  type DecisionCenterObservabilityInput,
} from "../observability";
import {
  makeAggregateDecision,
  makeEngine,
  makeRowDecision,
  makeSnapshot,
} from "./helpers";

function input(overrides: Partial<DecisionCenterObservabilityInput> = {}) {
  return {
    snapshot: makeSnapshot({
      todayBrief: [],
      rowDecisions: [
        makeRowDecision({
          creativeId: "mock-creative-001",
          rowId: "row_1",
          familyId: "family_1",
          buyerAction: "scale",
          buyerLabel: "Scale",
          uiBucket: "scale",
          confidenceBand: "high",
          priority: "medium",
          missingData: [],
          engine: makeEngine({
            primaryDecision: "Scale",
            actionability: "review_only",
            problemClass: "performance",
            confidence: 88,
            priority: "medium",
            missingData: [],
          }),
        }),
        makeRowDecision({
          creativeId: "mock-creative-002",
          rowId: "row_2",
          buyerAction: "diagnose_data",
          buyerLabel: "Diagnose data",
          uiBucket: "diagnose_data",
          confidenceBand: "low",
          priority: "high",
          reasons: ["campaign_label_missing"],
          missingData: [],
          engine: makeEngine({
            primaryDecision: "Scale",
            actionability: "review_only",
            problemClass: "performance",
            confidence: 82,
            priority: "high",
            missingData: [],
          }),
        }),
        makeRowDecision({
          creativeId: "mock-creative-003",
          rowId: "row_3",
          buyerAction: "diagnose_data",
          buyerLabel: "Diagnose data",
          uiBucket: "diagnose_data",
          confidenceBand: "low",
          priority: "critical",
          missingData: ["truth", "truth"],
          engine: makeEngine({
            primaryDecision: "Cut",
            actionability: "diagnose",
            problemClass: "data_quality",
            confidence: 75,
            priority: "critical",
            missingData: ["truth", "tracking"],
          }),
        }),
      ],
      aggregateDecisions: [
        makeAggregateDecision({
          familyId: "family_1",
          affectedCreativeIds: ["mock-creative-001", "mock-creative-002"],
          action: "brief_variation",
          scope: "family",
        }),
      ],
    }),
    businessIdHash: "hashed_business",
    accountIdHashes: ["hashed_account_2", "hashed_account_1", "hashed_account_1"],
    snapshotId: "hashed_snapshot",
    route: "GET /api/creatives/briefing" as const,
    decisionCenterRequested: true,
    ...overrides,
  };
}

describe("Decision Center observability", () => {
  it("emits deterministic event order and versioned snapshot metadata", () => {
    const first = buildDecisionCenterObservabilityEvents(input());
    const second = buildDecisionCenterObservabilityEvents(input());

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first[0]).toMatchObject({
      eventName: "decision_center.snapshot_observed",
      version: CREATIVE_DECISION_CENTER_OBSERVABILITY_VERSION,
      businessIdHash: "hashed_business",
      accountIdHashes: ["hashed_account_1", "hashed_account_2"],
      accountIdHashCount: 2,
      snapshotId: "hashed_snapshot",
      route: "GET /api/creatives/briefing",
      decisionCenterRequested: true,
      rowCount: 3,
      aggregateCount: 1,
      todayBriefCount: 0,
    });
  });

  it("does not emit raw business, account, row, creative, or family identifiers", () => {
    const events = buildDecisionCenterObservabilityEvents(input());
    const json = JSON.stringify(events);

    expect(json).not.toContain("biz_1");
    expect(json).not.toContain("act_1");
    expect(json).not.toContain("mock-creative");
    expect(json).not.toContain("row_1");
    expect(json).not.toContain("row_2");
    expect(json).not.toContain("row_3");
    expect(json).not.toContain("family_1");
    expect(json).not.toContain("https://");
    expect(json).not.toContain("Mock Creative");
  });

  it("counts missing data once per field per row from row and engine missing data", () => {
    const events = buildDecisionCenterObservabilityEvents(input());

    expect(events).toContainEqual(
      expect.objectContaining({
        eventName: "decision_center.missing_data",
        field: "truth",
        buyerAction: "diagnose_data",
        count: 1,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        eventName: "decision_center.missing_data",
        field: "tracking",
        buyerAction: "diagnose_data",
        count: 1,
      }),
    );
  });

  it("emits fallback and primary-to-buyer divergence rollout metrics", () => {
    const events = buildDecisionCenterObservabilityEvents(input());

    expect(events).toContainEqual(
      expect.objectContaining({
        eventName: "decision_center.fallback",
        buyerAction: "diagnose_data",
        reason: "campaign_label_missing",
        count: 1,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        eventName: "decision_center.fallback",
        buyerAction: "diagnose_data",
        reason: "missing_data",
        count: 1,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        eventName: "decision_center.primary_to_buyer_divergence",
        primaryDecision: "Scale",
        expectedBuyerAction: "scale",
        buyerAction: "diagnose_data",
        reason: "campaign_label_missing",
        count: 1,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        eventName: "decision_center.primary_to_buyer_divergence",
        primaryDecision: "Cut",
        expectedBuyerAction: "cut",
        buyerAction: "diagnose_data",
        reason: "missing_data",
        count: 1,
      }),
    );
  });

  it("emits action quality and aggregate distribution metrics without aggregate IDs", () => {
    const events = buildDecisionCenterObservabilityEvents(input());

    expect(events).toContainEqual(
      expect.objectContaining({
        eventName: "decision_center.high_confidence_action",
        buyerAction: "scale",
        count: 1,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        eventName: "decision_center.high_priority_low_confidence",
        buyerAction: "diagnose_data",
        priority: "critical",
        count: 1,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        eventName: "decision_center.aggregate_distribution",
        action: "brief_variation",
        scope: "family",
        count: 1,
      }),
    );
    expect(JSON.stringify(events)).not.toContain("affectedCreativeIds");
  });

  it("keeps empty snapshots to a single summary event", () => {
    const events = buildDecisionCenterObservabilityEvents(
      input({
        snapshot: makeSnapshot({
          todayBrief: [],
          rowDecisions: [],
          aggregateDecisions: [],
          missingDataSummary: {},
        }),
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventName: "decision_center.snapshot_observed",
      rowCount: 0,
      aggregateCount: 0,
      todayBriefCount: 0,
    });
  });

  it("exports the stable log marker used by the route emitter", () => {
    expect(DECISION_CENTER_OBSERVABILITY_LOG_MARKER).toBe(
      "[decision-center-observability]",
    );
  });
});
