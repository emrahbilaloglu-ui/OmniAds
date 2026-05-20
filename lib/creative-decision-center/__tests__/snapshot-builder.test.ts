import { describe, expect, it } from "vitest";
import {
  CREATIVE_DECISION_CENTER_SNAPSHOT_BUILDER_VERSION,
  assembleDecisionCenterSnapshot,
} from "../snapshot-builder";
import {
  adaptCreativeDecisionToRow,
  type CreativeDecisionCenterAdapterContext,
} from "../adapter";
import {
  CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
  type CreativeDecisionCenterRowDecision,
  type DecisionCenterSnapshot,
} from "../contracts";
import { validateDecisionCenterSnapshot } from "../validators";
import { auditDecisionCenterSnapshotInvariants } from "../invariants";
import { makeAggregateDecision, makeEngine } from "./helpers";

function adapterRow(args: {
  primaryDecision: Parameters<typeof makeEngine>[0] extends infer T
    ? T extends { primaryDecision?: infer P }
      ? P
      : never
    : never;
  campaignKind: CreativeDecisionCenterAdapterContext["campaignKind"];
  creativeId: string;
  missingData?: string[];
  problemClass?: ReturnType<typeof makeEngine>["problemClass"];
}): CreativeDecisionCenterRowDecision {
  return adaptCreativeDecisionToRow({
    engine: makeEngine({
      primaryDecision: args.primaryDecision,
      actionability: "review_only",
      problemClass: args.problemClass ?? "performance",
      confidence: 75,
      missingData: args.missingData ?? [],
      reasonTags: ["coverage"],
      evidenceSummary: `${args.primaryDecision} ${args.creativeId}`,
      blockerReasons: [],
    }),
    context: {
      creativeId: args.creativeId,
      rowId: `ad_${args.creativeId}`,
      identityGrain: "ad",
      familyId: null,
      campaignKind: args.campaignKind,
    },
  }).row;
}

describe("Creative Decision Center shadow snapshot builder", () => {
  it("exposes a stable builder version", () => {
    expect(CREATIVE_DECISION_CENTER_SNAPSHOT_BUILDER_VERSION).toBe(
      "creative-decision-center.snapshot-builder.v1",
    );
  });

  it("assembles a valid snapshot from adapter row decisions", () => {
    const rows = [
      adapterRow({
        primaryDecision: "Scale",
        campaignKind: "test",
        creativeId: "creative_a",
      }),
      adapterRow({
        primaryDecision: "Cut",
        campaignKind: "main",
        creativeId: "creative_b",
      }),
      adapterRow({
        primaryDecision: "Diagnose",
        campaignKind: "main",
        creativeId: "creative_c",
        problemClass: "policy",
      }),
    ];

    const { snapshot, trace } = assembleDecisionCenterSnapshot({
      engineVersion: "test-engine",
      adapterVersion: "test-adapter",
      configVersion: "test-config",
      generatedAt: "2026-05-20T00:00:00.000Z",
      dataFreshness: { status: "fresh", maxAgeHours: 12 },
      rowDecisions: rows,
    });

    expect(snapshot.contractVersion).toBe(
      CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
    );
    expect(snapshot.engineVersion).toBe("test-engine");
    expect(snapshot.adapterVersion).toBe("test-adapter");
    expect(snapshot.configVersion).toBe("test-config");
    expect(snapshot.rowDecisions).toHaveLength(3);
    expect(snapshot.aggregateDecisions).toEqual([]);
    expect(snapshot.todayBrief).toEqual([]);
    expect(snapshot.actionBoard.scale).toEqual(["ad_creative_a"]);
    expect(snapshot.actionBoard.cut).toEqual(["ad_creative_b"]);
    expect(snapshot.actionBoard.fix_policy).toEqual(["ad_creative_c"]);
    expect(trace.rowCount).toBe(3);
    expect(trace.aggregateCount).toBe(0);
    expect(trace.actionBoardSizes.scale).toBe(1);
    expect(trace.actionBoardSizes.cut).toBe(1);
    expect(trace.actionBoardSizes.fix_policy).toBe(1);
    expect(trace.actionBoardSizes.diagnose_data).toBe(0);

    const validation = validateDecisionCenterSnapshot(snapshot);
    expect(validation.ok, validation.errors.join(", ")).toBe(true);
    expect(auditDecisionCenterSnapshotInvariants(snapshot)).toEqual([]);
  });

  it("derives missingDataSummary deterministically and key-sorted", () => {
    const rows = [
      adapterRow({
        primaryDecision: "Diagnose",
        campaignKind: "main",
        creativeId: "creative_a",
        problemClass: "data_quality",
        missingData: ["truth", "freshness"],
      }),
      adapterRow({
        primaryDecision: "Diagnose",
        campaignKind: "main",
        creativeId: "creative_b",
        problemClass: "data_quality",
        missingData: ["truth"],
      }),
    ];

    const aggregates = [
      makeAggregateDecision({
        missingData: ["backlog"],
        affectedCreativeIds: ["creative_a"],
      }),
    ];

    const { snapshot } = assembleDecisionCenterSnapshot({
      engineVersion: "test-engine",
      adapterVersion: "test-adapter",
      configVersion: "test-config",
      generatedAt: "2026-05-20T00:00:00.000Z",
      dataFreshness: { status: "fresh", maxAgeHours: 12 },
      rowDecisions: rows,
      aggregateDecisions: aggregates,
    });

    // The adapter mirrors engine.missingData into row.missingData. The
    // builder counts a missing field once per row decision, using the union
    // of row.missingData and engine.missingData to avoid double-counting the
    // same blocker from the two mirrored surfaces.
    expect(snapshot.missingDataSummary).toEqual({
      backlog: 1,
      freshness: 1,
      truth: 2,
    });
    expect(Object.keys(snapshot.missingDataSummary)).toEqual([
      "backlog",
      "freshness",
      "truth",
    ]);
  });

  it("never auto-populates todayBrief or auto-ranks rows", () => {
    const rows = [
      adapterRow({
        primaryDecision: "Scale",
        campaignKind: "test",
        creativeId: "creative_a",
      }),
    ];

    const { snapshot } = assembleDecisionCenterSnapshot({
      engineVersion: "test-engine",
      adapterVersion: "test-adapter",
      configVersion: "test-config",
      generatedAt: "2026-05-20T00:00:00.000Z",
      dataFreshness: { status: "fresh", maxAgeHours: 12 },
      rowDecisions: rows,
    });

    expect(snapshot.todayBrief).toEqual([]);
  });

  it("preserves operator-provided todayBrief entries unchanged", () => {
    const todayBrief: DecisionCenterSnapshot["todayBrief"] = [
      {
        id: "brief_1",
        priority: "high",
        text: "Operator-authored brief.",
        rowIds: ["ad_creative_a"],
      },
    ];

    const { snapshot } = assembleDecisionCenterSnapshot({
      engineVersion: "test-engine",
      adapterVersion: "test-adapter",
      configVersion: "test-config",
      generatedAt: "2026-05-20T00:00:00.000Z",
      dataFreshness: { status: "fresh", maxAgeHours: 12 },
      rowDecisions: [],
      todayBrief,
    });

    expect(snapshot.todayBrief).toEqual(todayBrief);
    // Defensive copy: mutating the input must not change the snapshot.
    todayBrief.push({
      id: "brief_mutation",
      priority: "low",
      text: "should not appear",
      rowIds: [],
    });
    expect(snapshot.todayBrief).toHaveLength(1);
  });

  it("does not mutate input arrays when assembling", () => {
    const rows = [
      adapterRow({
        primaryDecision: "Scale",
        campaignKind: "test",
        creativeId: "creative_a",
      }),
    ];
    const rowsRef = rows;
    const { snapshot } = assembleDecisionCenterSnapshot({
      engineVersion: "test-engine",
      adapterVersion: "test-adapter",
      configVersion: "test-config",
      generatedAt: "2026-05-20T00:00:00.000Z",
      dataFreshness: { status: "fresh", maxAgeHours: 12 },
      rowDecisions: rows,
    });

    // Mutating the original input must not leak into the snapshot.
    rows.push(
      adapterRow({
        primaryDecision: "Cut",
        campaignKind: "main",
        creativeId: "creative_b",
      }),
    );
    expect(snapshot.rowDecisions).toHaveLength(1);
    expect(rows).toBe(rowsRef);
  });

  it("produces deterministic output for the same input", () => {
    const inputArgs = () => ({
      engineVersion: "test-engine",
      adapterVersion: "test-adapter",
      configVersion: "test-config",
      generatedAt: "2026-05-20T00:00:00.000Z",
      dataFreshness: { status: "fresh" as const, maxAgeHours: 12 },
      rowDecisions: [
        adapterRow({
          primaryDecision: "Scale",
          campaignKind: "test",
          creativeId: "creative_a",
        }),
        adapterRow({
          primaryDecision: "Refresh",
          campaignKind: "main",
          creativeId: "creative_b",
          problemClass: "fatigue",
        }),
      ],
    });

    const first = assembleDecisionCenterSnapshot(inputArgs()).snapshot;
    const second = assembleDecisionCenterSnapshot(inputArgs()).snapshot;
    expect(first).toEqual(second);
  });

  it("supplies an empty inputCoverageSummary when none is provided", () => {
    const { snapshot } = assembleDecisionCenterSnapshot({
      engineVersion: "test-engine",
      adapterVersion: "test-adapter",
      configVersion: "test-config",
      generatedAt: "2026-05-20T00:00:00.000Z",
      dataFreshness: { status: "unknown" },
      rowDecisions: [],
    });
    expect(snapshot.inputCoverageSummary).toEqual({});
    expect(snapshot.dataFreshness.maxAgeHours).toBeNull();
  });

  it("preserves operator-provided inputCoverageSummary verbatim", () => {
    const coverage = { truth: 0.92, freshness: 0.78 };
    const { snapshot } = assembleDecisionCenterSnapshot({
      engineVersion: "test-engine",
      adapterVersion: "test-adapter",
      configVersion: "test-config",
      generatedAt: "2026-05-20T00:00:00.000Z",
      dataFreshness: { status: "fresh", maxAgeHours: 12 },
      rowDecisions: [],
      inputCoverageSummary: coverage,
    });
    expect(snapshot.inputCoverageSummary).toEqual(coverage);
  });
});
