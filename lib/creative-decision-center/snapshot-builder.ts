/**
 * Creative Decision Center v2.1 shadow snapshot builder.
 *
 * This module is a structural assembly helper. It takes already-produced
 * row decisions (typically from the adapter) plus operator-provided
 * metadata and packs them into a `DecisionCenterSnapshot`. It does not
 * decide anything: no ranking, no top-N selection, no derived metrics
 * beyond a deterministic count aggregation over the row decisions it is
 * given.
 *
 * Hard constraints:
 * - The builder MUST NOT call into runtime engine, Meta, app, components,
 *   archive, or scripts modules. Only contract types/values are imported.
 * - The builder MUST NOT add new decision logic. It only assembles fields
 *   already produced by upstream (engine + adapter + operator metadata).
 * - The output snapshot must still pass `validateDecisionCenterSnapshot`.
 * - The shadow scope still applies: this builder is not wired into any
 *   route, UI, or default response in this slice.
 */

import {
  CREATIVE_DECISION_CENTER_BUYER_ACTIONS,
  CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
  type CreativeDecisionCenterAggregateDecision,
  type CreativeDecisionCenterBuyerAction,
  type CreativeDecisionCenterFreshnessStatus,
  type CreativeDecisionCenterRowDecision,
  type DecisionCenterSnapshot,
} from "./contracts";
import { createEmptyActionBoard } from "./validators";

export const CREATIVE_DECISION_CENTER_SNAPSHOT_BUILDER_VERSION =
  "creative-decision-center.snapshot-builder.v1";

export interface DecisionCenterSnapshotBuilderInput {
  engineVersion: string;
  adapterVersion: string;
  configVersion: string;
  generatedAt: string;
  dataFreshness: {
    status: CreativeDecisionCenterFreshnessStatus;
    maxAgeHours?: number | null;
  };
  /**
   * Operator-provided coverage map. The builder does not derive coverage
   * from raw signals; consumers compute or stub this upstream.
   */
  inputCoverageSummary?: Record<string, number>;
  /**
   * Operator-provided "Today brief" entries. Default is `[]`. The builder
   * does not rank, select, or pick a top-N - that would be a decision and
   * is out of scope. Pass an empty array unless an upstream operator
   * surface already produced curated entries.
   */
  todayBrief?: DecisionCenterSnapshot["todayBrief"];
  rowDecisions: CreativeDecisionCenterRowDecision[];
  aggregateDecisions?: CreativeDecisionCenterAggregateDecision[];
}

function preferredRowId(row: CreativeDecisionCenterRowDecision): string {
  return row.rowId ?? row.creativeId;
}

function deriveActionBoard(
  rows: readonly CreativeDecisionCenterRowDecision[],
): Record<CreativeDecisionCenterBuyerAction, string[]> {
  const board = createEmptyActionBoard();
  for (const row of rows) {
    if (CREATIVE_DECISION_CENTER_BUYER_ACTIONS.includes(row.buyerAction)) {
      board[row.buyerAction].push(preferredRowId(row));
    }
  }
  return board;
}

function deriveMissingDataSummary(
  rows: readonly CreativeDecisionCenterRowDecision[],
  aggregates: readonly CreativeDecisionCenterAggregateDecision[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const rowMissingData = new Set([...row.missingData, ...row.engine.missingData]);
    for (const entry of rowMissingData) {
      counts[entry] = (counts[entry] ?? 0) + 1;
    }
  }
  for (const aggregate of aggregates) {
    for (const entry of aggregate.missingData) {
      counts[entry] = (counts[entry] ?? 0) + 1;
    }
  }
  // Return a key-sorted object so the snapshot output is deterministic
  // regardless of row order or insertion order.
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export interface AssembledSnapshotTrace {
  rowCount: number;
  aggregateCount: number;
  actionBoardSizes: Record<CreativeDecisionCenterBuyerAction, number>;
  missingDataKeyCount: number;
}

export interface AssembledSnapshotResult {
  snapshot: DecisionCenterSnapshot;
  trace: AssembledSnapshotTrace;
}

export function assembleDecisionCenterSnapshot(
  input: DecisionCenterSnapshotBuilderInput,
): AssembledSnapshotResult {
  const rowDecisions = [...input.rowDecisions];
  const aggregateDecisions = input.aggregateDecisions
    ? [...input.aggregateDecisions]
    : [];
  const todayBrief = input.todayBrief ? [...input.todayBrief] : [];
  const actionBoard = deriveActionBoard(rowDecisions);
  const missingDataSummary = deriveMissingDataSummary(
    rowDecisions,
    aggregateDecisions,
  );

  const snapshot: DecisionCenterSnapshot = {
    contractVersion: CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
    engineVersion: input.engineVersion,
    adapterVersion: input.adapterVersion,
    configVersion: input.configVersion,
    generatedAt: input.generatedAt,
    dataFreshness: {
      status: input.dataFreshness.status,
      maxAgeHours: input.dataFreshness.maxAgeHours ?? null,
    },
    inputCoverageSummary: input.inputCoverageSummary
      ? { ...input.inputCoverageSummary }
      : {},
    missingDataSummary,
    todayBrief,
    actionBoard,
    rowDecisions,
    aggregateDecisions,
  };

  const actionBoardSizes = Object.fromEntries(
    CREATIVE_DECISION_CENTER_BUYER_ACTIONS.map((action) => [
      action,
      actionBoard[action].length,
    ]),
  ) as Record<CreativeDecisionCenterBuyerAction, number>;

  return {
    snapshot,
    trace: {
      rowCount: rowDecisions.length,
      aggregateCount: aggregateDecisions.length,
      actionBoardSizes,
      missingDataKeyCount: Object.keys(missingDataSummary).length,
    },
  };
}
