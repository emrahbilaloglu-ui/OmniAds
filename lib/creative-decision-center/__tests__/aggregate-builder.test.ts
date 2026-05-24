import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS,
  CREATIVE_DECISION_CENTER_BUYER_ACTIONS,
  type CreativeDecisionCenterAggregateAction,
} from "../contracts";
import {
  buildFatigueClusterAggregateCandidate,
  buildDecisionCenterAggregateDecisions,
  buildUnusedApprovedCreativesAggregateCandidate,
  buildWinnerGapAggregateCandidate,
  REQUIRED_AGGREGATE_DATA,
  type CreativeDecisionCenterAggregateCandidate,
} from "../aggregate-builder";
import {
  auditCreativeDecisionCenterAggregateInvariants,
} from "../invariants";
import {
  validateCreativeDecisionCenterAggregateDecision,
} from "../validators";

const DATA_READINESS_DOC = "docs/creative-decision-center/DATA_READINESS.md";

function validCandidate(
  overrides: Partial<CreativeDecisionCenterAggregateCandidate> = {},
): CreativeDecisionCenterAggregateCandidate {
  const action = overrides.action ?? "brief_variation";
  return {
    scope: "family",
    familyId: "family_1",
    action,
    priority: "medium",
    confidence: 55,
    oneLine: "Family needs a backup variant.",
    reasons: ["No backup variant is available."],
    affectedCreativeIds: ["creative_1", "creative_2"],
    nextStep: "Prepare a family-level variation brief.",
    missingData: [],
    availableData: [...REQUIRED_AGGREGATE_DATA[action]],
    ...overrides,
  };
}

function actionRowsInDataReadiness(): Set<string> {
  const source = readFileSync(DATA_READINESS_DOC, "utf8");
  return new Set(
    Array.from(
      source.matchAll(
        /^\|\s*(brief_variation|creative_supply_warning|winner_gap|fatigue_cluster|unused_approved_creatives)\s*\|/gm,
      ),
      ([, action]) => action,
    ),
  );
}

describe("Decision Center aggregate builder", () => {
  it("returns empty aggregateDecisions deterministically when no candidates exist", () => {
    const first = buildDecisionCenterAggregateDecisions({ candidates: [] });
    const second = buildDecisionCenterAggregateDecisions({ candidates: [] });

    expect(first.aggregateDecisions).toEqual([]);
    expect(first.trace).toEqual({
      candidateCount: 0,
      emittedCount: 0,
      suppressedCount: 0,
      suppressed: [],
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("keeps REQUIRED_AGGREGATE_DATA exhaustive for aggregate actions", () => {
    expect(Object.keys(REQUIRED_AGGREGATE_DATA)).toEqual([
      ...CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS,
    ]);
  });

  it("keeps aggregate action keys mapped to DATA_READINESS rows", () => {
    const actionRows = actionRowsInDataReadiness();

    for (const action of CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS) {
      expect(actionRows.has(action)).toBe(true);
    }
  });

  it("suppresses candidates when required family or supply data is absent", () => {
    const result = buildDecisionCenterAggregateDecisions({
      candidates: [
        validCandidate({
          availableData: ["family_winner_fatigue"],
        }),
      ],
    });

    expect(result.aggregateDecisions).toEqual([]);
    expect(result.trace.suppressed).toEqual([
      expect.objectContaining({
        action: "brief_variation",
        reason: "missing_required_data",
        missingRequiredData: [
          "backup_variant_status",
          "creative_supply_backlog",
        ],
      }),
    ]);
  });

  it("suppresses every aggregate action when its required data is missing", () => {
    const candidates = CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS.map((action) =>
      validCandidate({
        action,
        availableData: [],
      }),
    );

    const result = buildDecisionCenterAggregateDecisions({ candidates });

    expect(result.aggregateDecisions).toEqual([]);
    expect(result.trace.suppressed).toHaveLength(
      CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS.length,
    );
    for (const action of CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS) {
      expect(result.trace.suppressed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action,
            reason: "missing_required_data",
            missingRequiredData: [...REQUIRED_AGGREGATE_DATA[action]],
          }),
        ]),
      );
    }
  });

  it("suppresses family candidates without a familyId", () => {
    const result = buildDecisionCenterAggregateDecisions({
      candidates: [validCandidate({ familyId: null })],
    });

    expect(result.aggregateDecisions).toEqual([]);
    expect(result.trace.suppressed[0]).toMatchObject({
      action: "brief_variation",
      reason: "missing_family_id",
    });
  });

  it("suppresses candidates that already carry missingData", () => {
    const result = buildDecisionCenterAggregateDecisions({
      candidates: [
        validCandidate({
          missingData: ["creative_supply_backlog"],
        }),
      ],
    });

    expect(result.aggregateDecisions).toEqual([]);
    expect(result.trace.suppressed[0]).toMatchObject({
      action: "brief_variation",
      reason: "candidate_missing_data",
      candidateMissingData: ["creative_supply_backlog"],
    });
  });

  it("passes through valid explicit candidates without deriving row actions", () => {
    const result = buildDecisionCenterAggregateDecisions({
      candidates: [validCandidate()],
    });

    expect(result.aggregateDecisions).toEqual([
      {
        scope: "family",
        familyId: "family_1",
        action: "brief_variation",
        priority: "medium",
        confidence: 55,
        oneLine: "Family needs a backup variant.",
        reasons: ["No backup variant is available."],
        affectedCreativeIds: ["creative_1", "creative_2"],
        nextStep: "Prepare a family-level variation brief.",
        missingData: [],
      },
    ]);
    expect(validateCreativeDecisionCenterAggregateDecision(result.aggregateDecisions[0]))
      .toEqual({ ok: true, errors: [] });
    expect(auditCreativeDecisionCenterAggregateInvariants(result.aggregateDecisions[0]))
      .toEqual([]);
  });

  it("builds a page-level winner-gap candidate only from explicit winner cadence data", () => {
    const candidate = buildWinnerGapAggregateCandidate({
      lastWinnerDate: "2026-05-01",
      windowEndDate: "2026-05-20",
      affectedCreativeIds: ["creative_a", "creative_b"],
      availableData: [...REQUIRED_AGGREGATE_DATA.winner_gap],
    });

    const result = buildDecisionCenterAggregateDecisions({
      candidates: candidate ? [candidate] : [],
    });

    expect(result.aggregateDecisions).toEqual([
      expect.objectContaining({
        scope: "page",
        familyId: null,
        action: "winner_gap",
        oneLine: "No new winner for 19 days.",
        affectedCreativeIds: ["creative_a", "creative_b"],
      }),
    ]);
    expect(result.aggregateDecisions[0]).not.toHaveProperty("creativeId");
  });

  it("does not emit winner-gap candidates before the cadence threshold", () => {
    expect(
      buildWinnerGapAggregateCandidate({
        lastWinnerDate: "2026-05-17",
        windowEndDate: "2026-05-20",
        affectedCreativeIds: ["creative_a"],
        availableData: [...REQUIRED_AGGREGATE_DATA.winner_gap],
      }),
    ).toBeNull();
  });

  it("keeps missing winner-gap data suppressible instead of inventing evidence", () => {
    const candidate = buildWinnerGapAggregateCandidate({
      lastWinnerDate: null,
      windowEndDate: "2026-05-20",
      affectedCreativeIds: ["creative_a"],
      availableData: [...REQUIRED_AGGREGATE_DATA.winner_gap],
    });

    const result = buildDecisionCenterAggregateDecisions({
      candidates: candidate ? [candidate] : [],
    });

    expect(result.aggregateDecisions).toEqual([]);
    expect(result.trace.suppressed[0]).toMatchObject({
      action: "winner_gap",
      reason: "candidate_missing_data",
      candidateMissingData: ["last_winner_date"],
    });
  });

  it("suppresses derived aggregate candidates when required data availability is not explicit", () => {
    const candidate = buildWinnerGapAggregateCandidate({
      lastWinnerDate: "2026-05-01",
      windowEndDate: "2026-05-20",
      affectedCreativeIds: ["creative_a"],
    });

    const result = buildDecisionCenterAggregateDecisions({
      candidates: candidate ? [candidate] : [],
    });

    expect(result.aggregateDecisions).toEqual([]);
    expect(result.trace.suppressed[0]).toMatchObject({
      action: "winner_gap",
      reason: "missing_required_data",
      missingRequiredData: [...REQUIRED_AGGREGATE_DATA.winner_gap],
    });
  });

  it("builds unused-approved and fatigue-cluster candidates without binding them to random row ids", () => {
    const unused = buildUnusedApprovedCreativesAggregateCandidate({
      approvedUnusedCreativeIds: ["creative_unused_1", "creative_unused_2"],
      availableData: [...REQUIRED_AGGREGATE_DATA.unused_approved_creatives],
    });
    const fatigue = buildFatigueClusterAggregateCandidate({
      familyId: "family_1",
      fatiguedCreativeIds: ["creative_f1", "creative_f2", "creative_f3"],
      availableData: [...REQUIRED_AGGREGATE_DATA.fatigue_cluster],
    });

    const result = buildDecisionCenterAggregateDecisions({
      candidates: [unused, fatigue].filter(
        (candidate): candidate is CreativeDecisionCenterAggregateCandidate =>
          Boolean(candidate),
      ),
    });

    expect(result.aggregateDecisions).toEqual([
      expect.objectContaining({
        scope: "page",
        action: "unused_approved_creatives",
        affectedCreativeIds: ["creative_unused_1", "creative_unused_2"],
      }),
      expect.objectContaining({
        scope: "family",
        familyId: "family_1",
        action: "fatigue_cluster",
        affectedCreativeIds: ["creative_f1", "creative_f2", "creative_f3"],
      }),
    ]);
    for (const decision of result.aggregateDecisions) {
      expect(decision).not.toHaveProperty("creativeId");
      expect(validateCreativeDecisionCenterAggregateDecision(decision)).toEqual({
        ok: true,
        errors: [],
      });
    }
  });

  it("strips row-level fields from aggregate candidate input", () => {
    const adversarialCandidate = {
      ...validCandidate(),
      creativeId: "creative_singular_leak",
      buyerAction: "scale",
      uiBucket: "cut",
    } as CreativeDecisionCenterAggregateCandidate & {
      creativeId: string;
      buyerAction: string;
      uiBucket: string;
    };

    const result = buildDecisionCenterAggregateDecisions({
      candidates: [adversarialCandidate],
    });

    expect(result.aggregateDecisions).toHaveLength(1);
    expect(result.aggregateDecisions[0]).not.toHaveProperty("creativeId");
    expect(result.aggregateDecisions[0]).not.toHaveProperty("buyerAction");
    expect(result.aggregateDecisions[0]).not.toHaveProperty("uiBucket");
    expect(validateCreativeDecisionCenterAggregateDecision(result.aggregateDecisions[0]))
      .toEqual({ ok: true, errors: [] });
    expect(auditCreativeDecisionCenterAggregateInvariants(result.aggregateDecisions[0]))
      .toEqual([]);
  });

  it("does not allow aggregate action values to masquerade as row buyer actions", () => {
    const buyerActions = new Set<string>(CREATIVE_DECISION_CENTER_BUYER_ACTIONS);

    for (const action of CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS) {
      expect(buyerActions.has(action)).toBe(false);
    }
  });

  it("keeps required data mappings non-empty for every aggregate action", () => {
    for (const action of CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS) {
      const keys = REQUIRED_AGGREGATE_DATA[
        action as CreativeDecisionCenterAggregateAction
      ];
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((key) => key.trim().length > 0)).toBe(true);
    }
  });
});
