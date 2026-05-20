import { describe, expect, it } from "vitest";
import {
  CREATIVE_DECISION_CENTER_ADAPTER_MAPPING_TABLE,
  CREATIVE_DECISION_CENTER_ADAPTER_UNLABELED_SCALE_REASON,
  CREATIVE_DECISION_CENTER_ADAPTER_VERSION,
  adaptCreativeDecisionToRow,
  adaptCreativeDecisionsToRows,
  getAdapterPrimaryDecisionCoverage,
  type CreativeDecisionCenterAdapterContext,
  type CreativeDecisionCenterAdapterInput,
} from "../adapter";
import {
  CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS,
  type CreativeDecisionOsV21PrimaryDecision,
} from "../contracts";
import {
  auditCreativeDecisionCenterRowInvariants,
} from "../invariants";
import {
  validateCreativeDecisionCenterRowDecision,
} from "../validators";
import { makeEngine } from "./helpers";

function context(
  overrides: Partial<CreativeDecisionCenterAdapterContext> = {},
): CreativeDecisionCenterAdapterContext {
  return {
    creativeId: "creative_1",
    rowId: "ad_1",
    identityGrain: "ad",
    familyId: null,
    campaignKind: null,
    ...overrides,
  };
}

function input(
  engineOverrides: Parameters<typeof makeEngine>[0] = {},
  contextOverrides: Partial<CreativeDecisionCenterAdapterContext> = {},
  audit: { sourceDecision?: string | null } = {},
): CreativeDecisionCenterAdapterInput {
  return {
    engine: makeEngine(engineOverrides),
    context: context(contextOverrides),
    ...audit,
  };
}

describe("Creative Decision Center shadow adapter", () => {
  it("exposes a stable adapter version", () => {
    expect(CREATIVE_DECISION_CENTER_ADAPTER_VERSION).toBe(
      "creative-decision-center.shadow-adapter.v1",
    );
  });

  it("maps Test scale verdicts to promote_to_main execution action", () => {
    const { row, trace } = adaptCreativeDecisionToRow(
      input(
        {
          primaryDecision: "Scale",
          actionability: "review_only",
          problemClass: "performance",
          confidence: 80,
          missingData: [],
          reasonTags: ["strong_relative_winner"],
          evidenceSummary: "Test creative is a strong winner.",
          blockerReasons: [],
        },
        { campaignKind: "test" },
      ),
    );

    expect(row.buyerAction).toBe("scale");
    expect(row.uiBucket).toBe("scale");
    expect(row.executionAction).toBe("promote_to_main");
    expect(row.buyerLabel).toContain("Promote to main");
    expect(trace.matchedRuleId).toBe("scale-default");
    expect(trace.unlabeledScaleSafetyApplied).toBe(false);
  });

  it("maps Main scale verdicts to scale_budget execution action", () => {
    const { row } = adaptCreativeDecisionToRow(
      input(
        {
          primaryDecision: "Scale",
          actionability: "review_only",
          problemClass: "performance",
          confidence: 80,
          missingData: [],
          reasonTags: ["strong_relative_winner"],
          evidenceSummary: "Main creative cleared the scale gate.",
          blockerReasons: [],
        },
        { campaignKind: "main" },
      ),
    );

    expect(row.buyerAction).toBe("scale");
    expect(row.executionAction).toBe("scale_budget");
    expect(row.nextStep).toMatch(/budget/i);
  });

  it("maps Mixed scale verdicts to controlled_scale execution action", () => {
    const { row } = adaptCreativeDecisionToRow(
      input(
        {
          primaryDecision: "Scale",
          actionability: "review_only",
          problemClass: "performance",
          confidence: 80,
          missingData: [],
          reasonTags: ["strong_relative_winner"],
          evidenceSummary: "Mixed campaign is producing a scaler.",
          blockerReasons: [],
        },
        { campaignKind: "mixed" },
      ),
    );

    expect(row.buyerAction).toBe("scale");
    expect(row.executionAction).toBe("controlled_scale");
  });

  it("downgrades unlabeled scale verdicts to diagnose_data with no execution action", () => {
    const { row, trace } = adaptCreativeDecisionToRow(
      input(
        {
          primaryDecision: "Scale",
          actionability: "review_only",
          problemClass: "performance",
          confidence: 80,
          missingData: [],
          reasonTags: ["strong_relative_winner"],
          evidenceSummary: "Would-be scale, but campaign is unlabeled.",
          blockerReasons: [],
        },
        { campaignKind: null },
      ),
    );

    expect(row.buyerAction).toBe("diagnose_data");
    expect(row.executionAction).toBeNull();
    expect(row.reasons).toContain(
      CREATIVE_DECISION_CENTER_ADAPTER_UNLABELED_SCALE_REASON,
    );
    expect(trace.unlabeledScaleSafetyApplied).toBe(true);
    // The unlabeled-scale safety row must still satisfy the structural validator.
    const validation = validateCreativeDecisionCenterRowDecision(row);
    expect(validation.ok, validation.errors.join(", ")).toBe(true);
  });

  it("preserves null sourceDecision pass-through when no audit metadata is provided", () => {
    const { row } = adaptCreativeDecisionToRow(
      input(
        {
          primaryDecision: "Cut",
          actionability: "review_only",
          problemClass: "performance",
          confidence: 80,
          missingData: [],
          reasonTags: ["severe_sustained_loser"],
          evidenceSummary: "Mature loser.",
          blockerReasons: [],
        },
        { campaignKind: "main" },
      ),
    );
    expect(row.sourceDecision).toBeNull();
  });

  it("preserves cut/refresh/protect/test_more semantics without an execution action", () => {
    const cut = adaptCreativeDecisionToRow(
      input(
        {
          primaryDecision: "Cut",
          actionability: "review_only",
          problemClass: "performance",
          confidence: 80,
          missingData: [],
          reasonTags: ["severe_sustained_loser"],
          evidenceSummary: "Mature high-spend loser.",
          blockerReasons: [],
        },
        { campaignKind: "main" },
      ),
    ).row;
    const refresh = adaptCreativeDecisionToRow(
      input(
        {
          primaryDecision: "Refresh",
          actionability: "review_only",
          problemClass: "fatigue",
          confidence: 75,
          missingData: [],
          reasonTags: ["fatigue_composite"],
          evidenceSummary: "Winner entering fatigue.",
          blockerReasons: [],
        },
        { campaignKind: "main" },
      ),
    ).row;
    const protectRow = adaptCreativeDecisionToRow(
      input(
        {
          primaryDecision: "Protect",
          actionability: "review_only",
          problemClass: "performance",
          confidence: 80,
          missingData: [],
          reasonTags: ["stable_winner"],
          evidenceSummary: "Stable winner.",
          blockerReasons: [],
        },
        { campaignKind: "main" },
      ),
    ).row;
    const testMore = adaptCreativeDecisionToRow(
      input(
        {
          primaryDecision: "Test More",
          actionability: "review_only",
          problemClass: "insufficient_signal",
          confidence: 55,
          missingData: [],
          reasonTags: ["low_evidence"],
          evidenceSummary: "Signal is not yet decisive.",
          blockerReasons: [],
        },
        { campaignKind: "test" },
      ),
    ).row;

    for (const row of [cut, refresh, protectRow, testMore]) {
      expect(row.executionAction).toBeNull();
    }

    expect(cut.buyerAction).toBe("cut");
    expect(refresh.buyerAction).toBe("refresh");
    expect(protectRow.buyerAction).toBe("protect");
    expect(testMore.buyerAction).toBe("test_more");
  });

  it("maps Diagnose verdicts to fix_delivery/fix_policy/watch_launch/diagnose_data by problemClass", () => {
    const delivery = adaptCreativeDecisionToRow(
      input({
        primaryDecision: "Diagnose",
        actionability: "diagnose",
        problemClass: "delivery",
        confidence: 60,
        missingData: [],
        reasonTags: ["active_no_spend_24h"],
        evidenceSummary: "Active row, zero spend in 24h.",
        blockerReasons: [],
      }),
    ).row;
    const policy = adaptCreativeDecisionToRow(
      input({
        primaryDecision: "Diagnose",
        actionability: "diagnose",
        problemClass: "policy",
        confidence: 70,
        missingData: [],
        reasonTags: ["disapproved_or_limited"],
        evidenceSummary: "Disapproved creative.",
        blockerReasons: [],
      }),
    ).row;
    const launch = adaptCreativeDecisionToRow(
      input({
        primaryDecision: "Diagnose",
        actionability: "diagnose",
        problemClass: "launch_monitoring",
        confidence: 50,
        missingData: [],
        reasonTags: ["new_launch_window"],
        evidenceSummary: "New launch under 48h.",
        blockerReasons: [],
      }),
    ).row;
    const dataQuality = adaptCreativeDecisionToRow(
      input({
        primaryDecision: "Diagnose",
        actionability: "diagnose",
        problemClass: "data_quality",
        confidence: 30,
        missingData: ["truth"],
        reasonTags: ["truth_missing"],
        evidenceSummary: "Truth signal is missing.",
        blockerReasons: ["truth_missing"],
      }),
    ).row;

    expect(delivery.buyerAction).toBe("fix_delivery");
    expect(policy.buyerAction).toBe("fix_policy");
    expect(launch.buyerAction).toBe("watch_launch");
    expect(dataQuality.buyerAction).toBe("diagnose_data");
  });

  it("maps Test More + launch_monitoring to watch_launch", () => {
    const { row } = adaptCreativeDecisionToRow(
      input({
        primaryDecision: "Test More",
        actionability: "review_only",
        problemClass: "launch_monitoring",
        confidence: 55,
        missingData: [],
        reasonTags: ["new_launch_window"],
        evidenceSummary: "Watching launch window.",
        blockerReasons: [],
      }),
    );

    expect(row.buyerAction).toBe("watch_launch");
  });

  it("caps confidence band to low whenever engine.missingData is non-empty (INVARIANTS I20)", () => {
    const { row, trace } = adaptCreativeDecisionToRow(
      input(
        {
          primaryDecision: "Scale",
          actionability: "review_only",
          problemClass: "performance",
          confidence: 90,
          missingData: ["benchmark"],
          reasonTags: ["strong_relative_winner"],
          evidenceSummary: "Scale signal under missing benchmark.",
          blockerReasons: [],
        },
        { campaignKind: "main" },
      ),
    );

    expect(row.confidenceBand).toBe("low");
    expect(trace.confidenceCapApplied).toBe(true);
    expect(auditCreativeDecisionCenterRowInvariants(row)).toEqual([]);
  });

  it("derives high/medium/low confidence bands from numeric confidence when no missingData", () => {
    const high = adaptCreativeDecisionToRow(
      input({ confidence: 85, missingData: [], primaryDecision: "Cut", evidenceSummary: "x", reasonTags: [], blockerReasons: [] }),
    ).row;
    const medium = adaptCreativeDecisionToRow(
      input({ confidence: 55, missingData: [], primaryDecision: "Cut", evidenceSummary: "x", reasonTags: [], blockerReasons: [] }),
    ).row;
    const low = adaptCreativeDecisionToRow(
      input({ confidence: 25, missingData: [], primaryDecision: "Cut", evidenceSummary: "x", reasonTags: [], blockerReasons: [] }),
    ).row;
    expect(high.confidenceBand).toBe("high");
    expect(medium.confidenceBand).toBe("medium");
    expect(low.confidenceBand).toBe("low");
  });

  it("passes sourceDecision audit metadata through without parsing it for buyerAction", () => {
    const { row } = adaptCreativeDecisionToRow({
      ...input({
        primaryDecision: "Diagnose",
        problemClass: "campaign_context",
        actionability: "diagnose",
        confidence: 50,
        missingData: [],
        reasonTags: ["campaign_paused"],
        evidenceSummary: "Campaign is paused.",
        blockerReasons: [],
      }),
      sourceDecision: "keep",
    });

    expect(row.sourceDecision).toBe("keep");
    expect(row.buyerAction).toBe("diagnose_data");
  });

  it("never emits brief_variation on a row decision", () => {
    for (const decision of CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS) {
      const { row } = adaptCreativeDecisionToRow(
        input(
          {
            primaryDecision: decision,
            actionability: "review_only",
            problemClass: "performance",
            confidence: 55,
            missingData: [],
            reasonTags: ["coverage_check"],
            evidenceSummary: `${decision} coverage check`,
            blockerReasons: [],
          },
          { campaignKind: "main" },
        ),
      );
      expect(row.buyerAction).not.toBe("brief_variation");
      expect(row.uiBucket).not.toBe("brief_variation");
    }
  });

  it("only emits executionAction when buyerAction is scale (I22 enforcement)", () => {
    for (const decision of CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS) {
      for (const kind of ["test", "main", "mixed", null] as const) {
        const { row } = adaptCreativeDecisionToRow(
          input(
            {
              primaryDecision: decision,
              actionability: "review_only",
              problemClass: "performance",
              confidence: 55,
              missingData: [],
              reasonTags: ["coverage"],
              evidenceSummary: `${decision} / ${String(kind)}`,
              blockerReasons: [],
            },
            { campaignKind: kind },
          ),
        );
        if (row.buyerAction === "scale") {
          expect(row.executionAction).not.toBeNull();
        } else {
          expect(row.executionAction).toBeNull();
        }
      }
    }
  });

  it("yields row decisions that satisfy the structural validator", () => {
    const decisions: CreativeDecisionOsV21PrimaryDecision[] = [
      "Scale",
      "Cut",
      "Refresh",
      "Protect",
      "Test More",
      "Diagnose",
    ];
    for (const decision of decisions) {
      const { row } = adaptCreativeDecisionToRow(
        input(
          {
            primaryDecision: decision,
            actionability: "review_only",
            problemClass: "performance",
            confidence: 70,
            missingData: [],
            reasonTags: ["coverage"],
            evidenceSummary: `${decision} validator check`,
            blockerReasons: [],
          },
          { campaignKind: "main" },
        ),
      );
      const result = validateCreativeDecisionCenterRowDecision(row);
      expect(result.ok, `${decision} row validator errors: ${result.errors.join(", ")}`).toBe(
        true,
      );
    }
  });

  it("treats unknown V2.1 primary decisions defensively as diagnose_data", () => {
    const { row, trace } = adaptCreativeDecisionToRow({
      engine: {
        ...makeEngine(),
        primaryDecision: "Unknown" as unknown as CreativeDecisionOsV21PrimaryDecision,
        problemClass: "performance",
        actionability: "review_only",
        confidence: 60,
        missingData: [],
        reasonTags: [],
        blockerReasons: [],
        evidenceSummary: "Unknown verdict.",
      },
      context: context({ campaignKind: "main" }),
    });
    expect(row.buyerAction).toBe("diagnose_data");
    expect(trace.matchedRuleId).toBeNull();
  });

  it("batch-adapts multiple inputs deterministically", () => {
    const result = adaptCreativeDecisionsToRows([
      input(
        {
          primaryDecision: "Scale",
          actionability: "review_only",
          problemClass: "performance",
          confidence: 80,
          missingData: [],
          reasonTags: ["strong_relative_winner"],
          evidenceSummary: "Test winner.",
          blockerReasons: [],
        },
        { campaignKind: "test", creativeId: "creative_a" },
      ),
      input(
        {
          primaryDecision: "Cut",
          actionability: "review_only",
          problemClass: "performance",
          confidence: 75,
          missingData: [],
          reasonTags: ["severe_sustained_loser"],
          evidenceSummary: "Mature loser.",
          blockerReasons: [],
        },
        { campaignKind: "main", creativeId: "creative_b" },
      ),
    ]);

    expect(result.map((entry) => entry.row.buyerAction)).toEqual(["scale", "cut"]);
    expect(result.map((entry) => entry.row.executionAction)).toEqual([
      "promote_to_main",
      null,
    ]);
    // Re-run the same batch; outputs must be identical.
    expect(
      adaptCreativeDecisionsToRows([
        input(
          {
            primaryDecision: "Scale",
            actionability: "review_only",
            problemClass: "performance",
            confidence: 80,
            missingData: [],
            reasonTags: ["strong_relative_winner"],
            evidenceSummary: "Test winner.",
            blockerReasons: [],
          },
          { campaignKind: "test", creativeId: "creative_a" },
        ),
        input(
          {
            primaryDecision: "Cut",
            actionability: "review_only",
            problemClass: "performance",
            confidence: 75,
            missingData: [],
            reasonTags: ["severe_sustained_loser"],
            evidenceSummary: "Mature loser.",
            blockerReasons: [],
          },
          { campaignKind: "main", creativeId: "creative_b" },
        ),
      ]).map((entry) => entry.row),
    ).toEqual(result.map((entry) => entry.row));
  });

  it("covers every V2.1 primary decision in the mapping table", () => {
    const ruledDecisions = new Set(
      CREATIVE_DECISION_CENTER_ADAPTER_MAPPING_TABLE.map(
        (rule) => rule.when.primaryDecision,
      ).filter((entry): entry is CreativeDecisionOsV21PrimaryDecision => Boolean(entry)),
    );
    for (const decision of getAdapterPrimaryDecisionCoverage()) {
      expect(ruledDecisions.has(decision)).toBe(true);
    }
  });
});
