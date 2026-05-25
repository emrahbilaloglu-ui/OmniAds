import {
  type CreativeDecisionCenterAggregateAction,
  type CreativeDecisionCenterAggregateDecision,
  type CreativeDecisionCenterPriority,
} from "./contracts";

export const CREATIVE_DECISION_CENTER_AGGREGATE_BUILDER_VERSION =
  "creative-decision-center.aggregate-builder.v1";

export const AGGREGATE_WINNER_GAP_MIN_DAYS = 14;
export const AGGREGATE_UNUSED_APPROVED_MIN_COUNT = 1;
export const AGGREGATE_FATIGUE_CLUSTER_MIN_CREATIVES = 3;

export const REQUIRED_AGGREGATE_DATA = {
  brief_variation: [
    "family_winner_fatigue",
    "backup_variant_status",
    "creative_supply_backlog",
  ],
  creative_supply_warning: [
    "creative_supply_backlog",
    "recent_launches",
    "production_state",
  ],
  winner_gap: ["winner_cadence_window", "historical_snapshot_window"],
  fatigue_cluster: [
    "fatigue_trend_window",
    "cluster_definition",
    "performance_trend",
  ],
  unused_approved_creatives: [
    "creative_review_status",
    "delivery_proof",
    "lifetime_delivery",
  ],
} as const satisfies Record<CreativeDecisionCenterAggregateAction, readonly string[]>;

export type DecisionCenterAggregateSuppressionReason =
  | "candidate_missing_data"
  | "missing_family_id"
  | "missing_required_data";

export interface CreativeDecisionCenterAggregateCandidate {
  scope: "page" | "family";
  familyId?: string | null;
  action: CreativeDecisionCenterAggregateAction;
  priority: CreativeDecisionCenterPriority;
  confidence: number;
  oneLine: string;
  reasons: readonly string[];
  affectedCreativeIds: readonly string[];
  nextStep: string;
  missingData?: readonly string[];
  availableData?: readonly string[];
}

export interface DecisionCenterAggregateSuppression {
  index: number;
  action: CreativeDecisionCenterAggregateAction;
  scope: "page" | "family";
  familyId?: string | null;
  reason: DecisionCenterAggregateSuppressionReason;
  missingRequiredData: string[];
  candidateMissingData: string[];
}

export interface DecisionCenterAggregateBuildTrace {
  candidateCount: number;
  emittedCount: number;
  suppressedCount: number;
  suppressed: DecisionCenterAggregateSuppression[];
}

export interface DecisionCenterAggregateBuilderInput {
  candidates?: readonly CreativeDecisionCenterAggregateCandidate[];
}

export interface DecisionCenterAggregateBuilderResult {
  aggregateDecisions: CreativeDecisionCenterAggregateDecision[];
  trace: DecisionCenterAggregateBuildTrace;
}

function missingRequiredDataFor(
  candidate: CreativeDecisionCenterAggregateCandidate,
): string[] {
  const availableData = new Set(candidate.availableData ?? []);
  return REQUIRED_AGGREGATE_DATA[candidate.action].filter(
    (field) => !availableData.has(field),
  );
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function daysBetween(start: Date, end: Date): number {
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.floor((end.getTime() - start.getTime()) / dayMs);
}

function availableDataOrRequired(
  _action: CreativeDecisionCenterAggregateAction,
  availableData: readonly string[] | undefined,
) {
  return availableData ?? [];
}

export function buildWinnerGapAggregateCandidate(input: {
  scope?: "page" | "family";
  familyId?: string | null;
  lastWinnerDate: string | null;
  windowStartDate?: string | null;
  windowEndDate: string;
  affectedCreativeIds: readonly string[];
  availableData?: readonly string[];
  minDaysSinceWinner?: number;
}): CreativeDecisionCenterAggregateCandidate | null {
  const action: CreativeDecisionCenterAggregateAction = "winner_gap";
  const end = parseIsoDate(input.windowEndDate);
  const lastWinner = parseIsoDate(input.lastWinnerDate);
  const windowStart = parseIsoDate(input.windowStartDate);
  const cadenceReference = lastWinner ?? windowStart;
  const missingData = [
    ...(cadenceReference ? [] : ["winner_cadence_window"]),
    ...(end ? [] : ["historical_snapshot_window"]),
  ];
  const daysSinceWinner =
    cadenceReference && end ? daysBetween(cadenceReference, end) : null;
  const threshold = input.minDaysSinceWinner ?? AGGREGATE_WINNER_GAP_MIN_DAYS;

  if (missingData.length === 0 && (daysSinceWinner ?? 0) < threshold) {
    return null;
  }

  return {
    scope: input.scope ?? "page",
    familyId: input.familyId ?? null,
    action,
    priority: daysSinceWinner !== null && daysSinceWinner >= threshold * 2
      ? "high"
      : "medium",
    confidence: missingData.length > 0 ? 0 : 65,
    oneLine:
      daysSinceWinner === null
        ? "Winner cadence cannot be evaluated from the available snapshot."
        : lastWinner === null
          ? `No winner observed for ${daysSinceWinner} days in the available snapshot window.`
        : `No new winner for ${daysSinceWinner} days.`,
    reasons:
      daysSinceWinner === null
        ? ["last winner date or historical window is missing"]
        : lastWinner === null
          ? [
              `No scale decision exists between ${input.windowStartDate} and ${input.windowEndDate}; threshold is ${threshold} days.`,
            ]
        : [
            `Last winner date is ${input.lastWinnerDate}; threshold is ${threshold} days.`,
          ],
    affectedCreativeIds: [...input.affectedCreativeIds],
    nextStep:
      "Review current creative supply and plan a new test if no active winner is emerging.",
    missingData,
    availableData: availableDataOrRequired(action, input.availableData),
  };
}

export function buildUnusedApprovedCreativesAggregateCandidate(input: {
  approvedUnusedCreativeIds: readonly string[];
  approvedUnusedCount?: number | null;
  availableData?: readonly string[];
  minCount?: number;
}): CreativeDecisionCenterAggregateCandidate | null {
  const action: CreativeDecisionCenterAggregateAction =
    "unused_approved_creatives";
  const count = input.approvedUnusedCount ?? input.approvedUnusedCreativeIds.length;
  const threshold = input.minCount ?? AGGREGATE_UNUSED_APPROVED_MIN_COUNT;
  if (count < threshold) return null;

  return {
    scope: "page",
    familyId: null,
    action,
    priority: count >= threshold * 3 ? "high" : "medium",
    confidence: 70,
    oneLine: `${count} approved creative${count === 1 ? "" : "s"} have no delivery proof.`,
    reasons: [
      "Approved creative backlog exists but lifetime delivery proof is absent.",
    ],
    affectedCreativeIds: [...input.approvedUnusedCreativeIds],
    nextStep:
      "Choose the strongest approved assets and assign them to the next launch/test plan.",
    missingData: [],
    availableData: availableDataOrRequired(action, input.availableData),
  };
}

export function buildFatigueClusterAggregateCandidate(input: {
  familyId: string | null;
  fatiguedCreativeIds: readonly string[];
  availableData?: readonly string[];
  minCreatives?: number;
}): CreativeDecisionCenterAggregateCandidate | null {
  const action: CreativeDecisionCenterAggregateAction = "fatigue_cluster";
  const threshold = input.minCreatives ?? AGGREGATE_FATIGUE_CLUSTER_MIN_CREATIVES;
  if (input.fatiguedCreativeIds.length < threshold) return null;

  return {
    scope: "family",
    familyId: input.familyId,
    action,
    priority: "high",
    confidence: 72,
    oneLine: `${input.fatiguedCreativeIds.length} creatives in the same family show fatigue pressure.`,
    reasons: [
      "Multiple sibling creatives share fatigue trend evidence in the same cluster.",
    ],
    affectedCreativeIds: [...input.fatiguedCreativeIds],
    nextStep:
      "Brief a family-level replacement angle before scaling further spend into the cluster.",
    missingData: [],
    availableData: availableDataOrRequired(action, input.availableData),
  };
}

export function buildDecisionCenterAggregateDecisions(
  input: DecisionCenterAggregateBuilderInput = {},
): DecisionCenterAggregateBuilderResult {
  const candidates = input.candidates ?? [];
  const aggregateDecisions: CreativeDecisionCenterAggregateDecision[] = [];
  const suppressed: DecisionCenterAggregateSuppression[] = [];

  candidates.forEach((candidate, index) => {
    const candidateMissingData = [...(candidate.missingData ?? [])];
    const missingRequiredData = missingRequiredDataFor(candidate);
    let reason: DecisionCenterAggregateSuppressionReason | null = null;

    if (candidate.scope === "family" && !candidate.familyId?.trim()) {
      reason = "missing_family_id";
    } else if (candidateMissingData.length > 0) {
      reason = "candidate_missing_data";
    } else if (missingRequiredData.length > 0) {
      reason = "missing_required_data";
    }

    if (reason) {
      suppressed.push({
        index,
        action: candidate.action,
        scope: candidate.scope,
        familyId: candidate.familyId ?? null,
        reason,
        missingRequiredData,
        candidateMissingData,
      });
      return;
    }

    aggregateDecisions.push({
      scope: candidate.scope,
      familyId: candidate.familyId ?? null,
      action: candidate.action,
      priority: candidate.priority,
      confidence: candidate.confidence,
      oneLine: candidate.oneLine,
      reasons: [...candidate.reasons],
      affectedCreativeIds: [...candidate.affectedCreativeIds],
      nextStep: candidate.nextStep,
      missingData: [],
    });
  });

  return {
    aggregateDecisions,
    trace: {
      candidateCount: candidates.length,
      emittedCount: aggregateDecisions.length,
      suppressedCount: suppressed.length,
      suppressed,
    },
  };
}
