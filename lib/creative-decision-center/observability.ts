import {
  type CreativeDecisionCenterBuyerAction,
  type CreativeDecisionCenterPriority,
  type CreativeDecisionOsV21PrimaryDecision,
  type DecisionCenterSnapshot,
} from "./contracts";

export const CREATIVE_DECISION_CENTER_OBSERVABILITY_VERSION =
  "creative-decision-center.observability.v1";

export const DECISION_CENTER_OBSERVABILITY_LOG_MARKER =
  "[decision-center-observability]";

export type DecisionCenterObservabilityRoute = "GET /api/creatives/briefing";

export interface DecisionCenterObservabilityInput {
  snapshot: DecisionCenterSnapshot;
  businessIdHash: string;
  accountIdHashes: readonly string[];
  snapshotId: string;
  route: DecisionCenterObservabilityRoute;
  decisionCenterRequested: boolean;
}

type DecisionCenterObservabilityEvent =
  | DecisionCenterSnapshotObservedEvent
  | DecisionCenterRowDistributionEvent
  | DecisionCenterAggregateDistributionEvent
  | DecisionCenterMissingDataEvent
  | DecisionCenterFallbackEvent
  | DecisionCenterPrimaryToBuyerDivergenceEvent
  | DecisionCenterHighConfidenceActionEvent
  | DecisionCenterHighPriorityLowConfidenceEvent;

interface DecisionCenterObservabilityBase {
  eventName: string;
  version: typeof CREATIVE_DECISION_CENTER_OBSERVABILITY_VERSION;
  businessIdHash: string;
  snapshotId: string;
  route: DecisionCenterObservabilityRoute;
  decisionCenterRequested: boolean;
}

interface DecisionCenterSnapshotObservedEvent
  extends DecisionCenterObservabilityBase {
  eventName: "decision_center.snapshot_observed";
  accountIdHashes: string[];
  accountIdHashCount: number;
  rowCount: number;
  aggregateCount: number;
  todayBriefCount: number;
  engineVersion: string;
  adapterVersion: string;
  configVersion: string;
  dataFreshnessStatus: DecisionCenterSnapshot["dataFreshness"]["status"];
  staleData: boolean;
}

interface DecisionCenterRowDistributionEvent
  extends DecisionCenterObservabilityBase {
  eventName: "decision_center.row_distribution";
  buyerAction: CreativeDecisionCenterBuyerAction;
  primaryDecision: CreativeDecisionOsV21PrimaryDecision;
  problemClass: string;
  actionability: string;
  confidenceBand: string;
  priority: CreativeDecisionCenterPriority;
  count: number;
}

interface DecisionCenterAggregateDistributionEvent
  extends DecisionCenterObservabilityBase {
  eventName: "decision_center.aggregate_distribution";
  action: string;
  scope: string;
  count: number;
}

interface DecisionCenterMissingDataEvent extends DecisionCenterObservabilityBase {
  eventName: "decision_center.missing_data";
  field: string;
  buyerAction: CreativeDecisionCenterBuyerAction;
  count: number;
}

type DecisionCenterFallbackReason =
  | "campaign_label_missing"
  | "missing_data"
  | "default_diagnose"
  | "unknown";

interface DecisionCenterFallbackEvent extends DecisionCenterObservabilityBase {
  eventName: "decision_center.fallback";
  buyerAction: "diagnose_data";
  reason: DecisionCenterFallbackReason;
  count: number;
}

interface DecisionCenterPrimaryToBuyerDivergenceEvent
  extends DecisionCenterObservabilityBase {
  eventName: "decision_center.primary_to_buyer_divergence";
  primaryDecision: "Scale" | "Cut" | "Refresh" | "Protect";
  expectedBuyerAction: "scale" | "cut" | "refresh" | "protect";
  buyerAction: CreativeDecisionCenterBuyerAction;
  reason: DecisionCenterFallbackReason | "non_direct_buyer_action";
  count: number;
}

interface DecisionCenterHighConfidenceActionEvent
  extends DecisionCenterObservabilityBase {
  eventName: "decision_center.high_confidence_action";
  buyerAction: CreativeDecisionCenterBuyerAction;
  count: number;
}

interface DecisionCenterHighPriorityLowConfidenceEvent
  extends DecisionCenterObservabilityBase {
  eventName: "decision_center.high_priority_low_confidence";
  buyerAction: CreativeDecisionCenterBuyerAction;
  priority: Extract<CreativeDecisionCenterPriority, "critical" | "high">;
  count: number;
}

type CountEntry<T extends Record<string, unknown>> = T & { count: number };

type DirectPrimaryDecision = "Scale" | "Cut" | "Refresh" | "Protect";

function directBuyerActionForPrimary(
  primaryDecision: CreativeDecisionOsV21PrimaryDecision,
): {
  primaryDecision: DirectPrimaryDecision;
  expectedBuyerAction: "scale" | "cut" | "refresh" | "protect";
} | null {
  if (primaryDecision === "Scale") {
    return { primaryDecision, expectedBuyerAction: "scale" };
  }
  if (primaryDecision === "Cut") {
    return { primaryDecision, expectedBuyerAction: "cut" };
  }
  if (primaryDecision === "Refresh") {
    return { primaryDecision, expectedBuyerAction: "refresh" };
  }
  if (primaryDecision === "Protect") {
    return { primaryDecision, expectedBuyerAction: "protect" };
  }
  return null;
}

function baseEvent(
  input: DecisionCenterObservabilityInput,
): DecisionCenterObservabilityBase {
  return {
    eventName: "",
    version: CREATIVE_DECISION_CENTER_OBSERVABILITY_VERSION,
    businessIdHash: input.businessIdHash,
    snapshotId: input.snapshotId,
    route: input.route,
    decisionCenterRequested: input.decisionCenterRequested,
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function rowMissingData(
  row: DecisionCenterSnapshot["rowDecisions"][number],
): string[] {
  return sortedUnique([...row.missingData, ...row.engine.missingData]);
}

function increment<T extends Record<string, unknown>>(
  map: Map<string, CountEntry<T>>,
  fields: T,
) {
  const key = JSON.stringify(fields);
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  map.set(key, { ...fields, count: 1 });
}

function sortedCounts<T extends Record<string, unknown>>(
  map: Map<string, CountEntry<T>>,
): CountEntry<T>[] {
  return Array.from(map.values()).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function fallbackReasonForRow(
  row: DecisionCenterSnapshot["rowDecisions"][number],
): DecisionCenterFallbackReason | null {
  if (row.buyerAction !== "diagnose_data") return null;
  if (row.reasons.includes("campaign_label_missing")) {
    return "campaign_label_missing";
  }
  if (rowMissingData(row).length > 0) return "missing_data";
  if (row.engine.primaryDecision === "Diagnose") return "default_diagnose";
  return "unknown";
}

export function buildDecisionCenterObservabilityEvents(
  input: DecisionCenterObservabilityInput,
): DecisionCenterObservabilityEvent[] {
  const base = baseEvent(input);
  const events: DecisionCenterObservabilityEvent[] = [
    {
      ...base,
      eventName: "decision_center.snapshot_observed",
      accountIdHashes: sortedUnique(input.accountIdHashes),
      accountIdHashCount: sortedUnique(input.accountIdHashes).length,
      rowCount: input.snapshot.rowDecisions.length,
      aggregateCount: input.snapshot.aggregateDecisions.length,
      todayBriefCount: input.snapshot.todayBrief.length,
      engineVersion: input.snapshot.engineVersion,
      adapterVersion: input.snapshot.adapterVersion,
      configVersion: input.snapshot.configVersion,
      dataFreshnessStatus: input.snapshot.dataFreshness.status,
      staleData: input.snapshot.dataFreshness.status === "stale",
    },
  ];

  const rowDistribution = new Map<
    string,
    CountEntry<
      Omit<
        DecisionCenterRowDistributionEvent,
        keyof DecisionCenterObservabilityBase | "eventName" | "count"
      >
    >
  >();
  const missingData = new Map<
    string,
    CountEntry<
      Omit<
        DecisionCenterMissingDataEvent,
        keyof DecisionCenterObservabilityBase | "eventName" | "count"
      >
    >
  >();
  const fallbacks = new Map<
    string,
    CountEntry<
      Omit<
        DecisionCenterFallbackEvent,
        keyof DecisionCenterObservabilityBase | "eventName" | "count"
      >
    >
  >();
  const divergences = new Map<
    string,
    CountEntry<
      Omit<
        DecisionCenterPrimaryToBuyerDivergenceEvent,
        keyof DecisionCenterObservabilityBase | "eventName" | "count"
      >
    >
  >();
  const highConfidenceActions = new Map<
    string,
    CountEntry<
      Omit<
        DecisionCenterHighConfidenceActionEvent,
        keyof DecisionCenterObservabilityBase | "eventName" | "count"
      >
    >
  >();
  const highPriorityLowConfidence = new Map<
    string,
    CountEntry<
      Omit<
        DecisionCenterHighPriorityLowConfidenceEvent,
        keyof DecisionCenterObservabilityBase | "eventName" | "count"
      >
    >
  >();

  for (const row of input.snapshot.rowDecisions) {
    increment(rowDistribution, {
      buyerAction: row.buyerAction,
      primaryDecision: row.engine.primaryDecision,
      problemClass: row.engine.problemClass,
      actionability: row.engine.actionability,
      confidenceBand: row.confidenceBand,
      priority: row.priority,
    });

    for (const field of rowMissingData(row)) {
      increment(missingData, { field, buyerAction: row.buyerAction });
    }

    const fallbackReason = fallbackReasonForRow(row);
    if (fallbackReason) {
      increment(fallbacks, {
        buyerAction: "diagnose_data",
        reason: fallbackReason,
      });
    }

    const directMapping = directBuyerActionForPrimary(row.engine.primaryDecision);
    if (
      directMapping &&
      row.buyerAction !== directMapping.expectedBuyerAction
    ) {
      increment(divergences, {
        primaryDecision: directMapping.primaryDecision,
        expectedBuyerAction: directMapping.expectedBuyerAction,
        buyerAction: row.buyerAction,
        reason: fallbackReason ?? "non_direct_buyer_action",
      });
    }

    if (row.confidenceBand === "high" && rowMissingData(row).length === 0) {
      increment(highConfidenceActions, { buyerAction: row.buyerAction });
    }

    if (
      row.confidenceBand === "low" &&
      (row.priority === "critical" || row.priority === "high")
    ) {
      increment(highPriorityLowConfidence, {
        buyerAction: row.buyerAction,
        priority: row.priority,
      });
    }
  }

  events.push(
    ...sortedCounts(rowDistribution).map((entry) => ({
      ...base,
      eventName: "decision_center.row_distribution" as const,
      ...entry,
    })),
  );

  const aggregateDistribution = new Map<
    string,
    CountEntry<
      Omit<
        DecisionCenterAggregateDistributionEvent,
        keyof DecisionCenterObservabilityBase | "eventName" | "count"
      >
    >
  >();
  for (const aggregate of input.snapshot.aggregateDecisions) {
    increment(aggregateDistribution, {
      action: aggregate.action,
      scope: aggregate.scope,
    });
  }

  events.push(
    ...sortedCounts(aggregateDistribution).map((entry) => ({
      ...base,
      eventName: "decision_center.aggregate_distribution" as const,
      ...entry,
    })),
    ...sortedCounts(missingData).map((entry) => ({
      ...base,
      eventName: "decision_center.missing_data" as const,
      ...entry,
    })),
    ...sortedCounts(fallbacks).map((entry) => ({
      ...base,
      eventName: "decision_center.fallback" as const,
      ...entry,
    })),
    ...sortedCounts(divergences).map((entry) => ({
      ...base,
      eventName: "decision_center.primary_to_buyer_divergence" as const,
      ...entry,
    })),
    ...sortedCounts(highConfidenceActions).map((entry) => ({
      ...base,
      eventName: "decision_center.high_confidence_action" as const,
      ...entry,
    })),
    ...sortedCounts(highPriorityLowConfidence).map((entry) => ({
      ...base,
      eventName: "decision_center.high_priority_low_confidence" as const,
      ...entry,
    })),
  );

  return events;
}
