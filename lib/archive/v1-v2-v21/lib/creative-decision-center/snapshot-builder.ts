import type { CreativeDecisionOsSnapshot } from "@/lib/creative-decision-os-snapshots";
import {
  CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
  type CreativeDecisionCenterAggregateDecision,
  type CreativeDecisionCenterRowDecision,
  type DecisionCenterSnapshot,
} from "@/lib/creative-decision-center/contracts";
import { getCreativeDecisionCenterV21DefaultConfig } from "@/lib/creative-decision-center/config";
import { validateDecisionCenterSnapshot } from "@/lib/creative-decision-center/validators";
import { buildCreativeDecisionCenterV21FeatureRows } from "@/lib/creative-decision-center/feature-row";
import {
  adaptCreativeDecisionCenterBuyerAction,
  confidenceBand,
} from "@/lib/creative-decision-center/buyer-adapter";
import {
  CREATIVE_DECISION_OS_V21_ENGINE_VERSION,
  resolveCreativeDecisionOsV21,
} from "@/lib/creative-decision-os-v2";

export function emptyCreativeDecisionCenterActionBoard(): DecisionCenterSnapshot["actionBoard"] {
  return {
    scale: [],
    cut: [],
    refresh: [],
    protect: [],
    test_more: [],
    watch_launch: [],
    fix_delivery: [],
    fix_policy: [],
    diagnose_data: [],
  };
}

function resolveSnapshotFreshness(
  snapshot: CreativeDecisionOsSnapshot,
  generatedAt: string,
  staleHours: number,
): DecisionCenterSnapshot["dataFreshness"] {
  const generated = Date.parse(generatedAt);
  const snapshotGenerated = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generated) || !Number.isFinite(snapshotGenerated)) {
    return { status: "unknown", maxAgeHours: null };
  }
  const maxAgeHours = Number(
    Math.max(0, (generated - snapshotGenerated) / 3_600_000).toFixed(2),
  );
  return {
    status: maxAgeHours > staleHours ? "stale" : "fresh",
    maxAgeHours,
  };
}

function buildMissingDataSummary(
  rowDecisions: CreativeDecisionCenterRowDecision[],
) {
  return rowDecisions.reduce<Record<string, number>>((acc, row) => {
    for (const field of row.missingData) {
      acc[field] = (acc[field] ?? 0) + 1;
    }
    return acc;
  }, {});
}

function buildTodayBrief(
  rowDecisions: CreativeDecisionCenterRowDecision[],
  aggregateDecisions: CreativeDecisionCenterAggregateDecision[],
): DecisionCenterSnapshot["todayBrief"] {
  const priorityScore = { critical: 4, high: 3, medium: 2, low: 1 };
  const rows = [...rowDecisions]
    .sort((left, right) => {
      const priorityDelta = priorityScore[right.priority] - priorityScore[left.priority];
      if (priorityDelta !== 0) return priorityDelta;
      const confidenceDelta = right.engine.confidence - left.engine.confidence;
      if (confidenceDelta !== 0) return confidenceDelta;
      return left.creativeId.localeCompare(right.creativeId);
    })
    .slice(0, 5)
    .map((row, index) => ({
      id: `row-${index + 1}-${row.creativeId}`,
      priority: row.priority,
      text: row.oneLine,
      rowIds: [row.rowId ?? row.creativeId],
    }));

  const aggregates = [...aggregateDecisions]
    .sort((left, right) => {
      const priorityDelta = priorityScore[right.priority] - priorityScore[left.priority];
      if (priorityDelta !== 0) return priorityDelta;
      return right.confidence - left.confidence;
    })
    .slice(0, Math.max(0, 5 - rows.length))
    .map((aggregate, index) => ({
      id: `aggregate-${index + 1}-${aggregate.scope}-${aggregate.familyId ?? "page"}`,
      priority: aggregate.priority,
      text: aggregate.oneLine,
      rowIds: [],
      aggregateIds: [`${aggregate.scope}:${aggregate.familyId ?? aggregate.action}`],
    }));

  return [...rows, ...aggregates];
}

function buildAggregateDecisions(
  snapshot: CreativeDecisionOsSnapshot,
  generatedAt: string,
): CreativeDecisionCenterAggregateDecision[] {
  void generatedAt;
  const payload = snapshot.payload;
  if (!payload) return [];

  const familyById = new Map((payload.families ?? []).map((family) => [family.familyId, family]));
  return (payload.supplyPlan ?? [])
    .filter((item) => item.familyId && item.creativeIds.length > 0)
    .slice(0, 5)
    .map((item): CreativeDecisionCenterAggregateDecision => {
      const family = familyById.get(item.familyId);
      return {
        scope: "family",
        familyId: item.familyId,
        action: "brief_variation",
        priority: item.priority,
        confidence: family?.provenance.confidence === "high" ? 74 : 62,
        oneLine: item.summary,
        reasons: item.reasons.length > 0 ? item.reasons : ["Family-level supply plan exists."],
        affectedCreativeIds: item.creativeIds,
        nextStep: "Prepare a family-level creative variation brief.",
        missingData: [],
      };
    });
}

export function buildCreativeDecisionCenterV21Snapshot(input: {
  snapshot: CreativeDecisionOsSnapshot;
  generatedAt?: string;
  enableRows?: boolean;
}): DecisionCenterSnapshot {
  const config = getCreativeDecisionCenterV21DefaultConfig();
  const payload = input.snapshot.payload;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const featureRows = input.enableRows
    ? buildCreativeDecisionCenterV21FeatureRows({
        snapshot: input.snapshot,
        now: generatedAt,
        config,
      })
    : [];
  const rowDecisions = featureRows
    .map((featureRow): CreativeDecisionCenterRowDecision | null => {
      const engine = resolveCreativeDecisionOsV21(featureRow, config);
      const adapted = adaptCreativeDecisionCenterBuyerAction(engine, {
        availableData: featureRow.availableData,
      });
      const rowDecision: CreativeDecisionCenterRowDecision = {
        scope: "creative",
        creativeId: featureRow.creativeId,
        rowId: featureRow.rowId ?? featureRow.creativeId,
        identityGrain: featureRow.identityGrain,
        familyId: featureRow.familyId ?? null,
        engine,
        buyerAction: adapted.buyerAction,
        buyerLabel: adapted.buyerLabel,
        uiBucket: adapted.uiBucket,
        confidenceBand: confidenceBand(engine.confidence),
        priority: engine.priority,
        oneLine: engine.evidenceSummary,
        reasons: engine.reasonTags,
        nextStep: adapted.nextStep,
        missingData: adapted.missingData,
      };
      return rowDecision;
    })
    .filter((row): row is CreativeDecisionCenterRowDecision => Boolean(row));
  const actionBoard = emptyCreativeDecisionCenterActionBoard();
  for (const row of rowDecisions) {
    actionBoard[row.uiBucket].push(row.rowId ?? row.creativeId);
  }
  const aggregateDecisions = input.enableRows
    ? buildAggregateDecisions(input.snapshot, generatedAt)
    : [];
  const missingDataSummary = buildMissingDataSummary(rowDecisions);
  const dataFreshnessStatus = resolveSnapshotFreshness(input.snapshot, generatedAt, config.staleDataHours);

  return {
    contractVersion: CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
    engineVersion: input.enableRows
      ? CREATIVE_DECISION_OS_V21_ENGINE_VERSION
      : "creative-decision-os.v2.1-shadow-empty",
    adapterVersion: "creative-decision-center.buyer-adapter.v0",
    configVersion: config.configVersion,
    generatedAt,
    dataFreshness: {
      status: dataFreshnessStatus.status,
      maxAgeHours: dataFreshnessStatus.maxAgeHours,
    },
    inputCoverageSummary: {
      totalCreatives: payload?.creatives.length ?? 0,
      rowDecisions: rowDecisions.length,
      aggregateDecisions: aggregateDecisions.length,
    },
    missingDataSummary,
    todayBrief: buildTodayBrief(rowDecisions, aggregateDecisions),
    actionBoard,
    rowDecisions,
    aggregateDecisions,
  };
}

export function buildValidatedCreativeDecisionCenterV21Snapshot(input: {
  snapshot: CreativeDecisionOsSnapshot | null;
  generatedAt?: string;
  enableRows?: boolean;
}): DecisionCenterSnapshot | null {
  if (!input.snapshot || input.snapshot.status !== "ready" || !input.snapshot.payload) {
    return null;
  }

  try {
    const decisionCenter = buildCreativeDecisionCenterV21Snapshot({
      snapshot: input.snapshot,
      generatedAt: input.generatedAt,
      enableRows: input.enableRows,
    });
    const validation = validateDecisionCenterSnapshot(decisionCenter);
    return validation.ok ? decisionCenter : null;
  } catch {
    return null;
  }
}
