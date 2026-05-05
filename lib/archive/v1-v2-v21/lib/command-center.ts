import type { MembershipRole } from "@/lib/auth";
import {
  buildOperatorActionFingerprint,
  buildOperatorDecisionPushEligibility,
  type OperatorDecisionProvenance,
} from "@/lib/operator-decision-provenance";
import { buildOperatorInstruction } from "@/lib/operator-prescription";
import type {
  CreativeDecisionOsCreative,
  CreativeOpportunityBoardItem,
  CreativeDecisionOsV1Response,
} from "@/lib/creative-decision-os";
import type { MetaCampaignFamily } from "@/lib/meta/campaign-lanes";
import type {
  MetaAdSetDecision,
  MetaBudgetShift,
  MetaDecisionEvidence,
  MetaDecisionOsV1Response,
  MetaGeoDecision,
  MetaNoTouchItem,
  MetaOpportunityBoardItem,
  MetaPlacementAnomaly,
} from "@/lib/meta/decision-os";
import type {
  OperatorAnalyticsWindow,
  OperatorDecisionWindows,
  OperatorHistoricalMemory,
  OperatorInstruction,
  OperatorInstructionAmountGuidance,
  OperatorDecisionPushEligibility,
  OperatorPolicyAssessment,
} from "@/src/types/operator-decision";
import { META_EXECUTION_SUPPORTED_ACTIONS } from "@/lib/command-center-execution-allowlist";
import type {
  BusinessDecisionBidRegime,
  BusinessDecisionCalibrationChannel,
  BusinessDecisionCalibrationProfile,
  BusinessDecisionObjectiveFamily,
} from "@/src/types/business-commercial";
import {
  DECISION_SURFACE_LANES,
  type DecisionEvidenceFloor,
  type DecisionOperatorDisposition,
  type DecisionPolicyExplanation,
  type DecisionReadReliability,
  type DecisionSurfaceAuthority,
  type DecisionSurfaceLane,
  type DecisionSourceHealthEntry,
  type DecisionTruthState,
} from "@/src/types/decision-trust";

export const COMMAND_CENTER_CONTRACT_VERSION = "command-center.v1" as const;
export const COMMAND_CENTER_ACTION_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "snoozed",
  "completed_manual",
  "executed",
  "failed",
  "canceled",
] as const;

export type CommandCenterActionStatus =
  (typeof COMMAND_CENTER_ACTION_STATUSES)[number];

export const COMMAND_CENTER_ACTION_MUTATIONS = [
  "approve",
  "reject",
  "snooze",
  "assign",
  "reopen",
  "complete_manual",
  "cancel",
  "fail",
] as const;

export type CommandCenterActionMutation =
  (typeof COMMAND_CENTER_ACTION_MUTATIONS)[number];

export const COMMAND_CENTER_JOURNAL_EVENT_TYPES = [
  "status_changed",
  "assignee_changed",
  "note_added",
  "handoff_created",
  "handoff_acknowledged",
] as const;

export type CommandCenterJournalEventType =
  (typeof COMMAND_CENTER_JOURNAL_EVENT_TYPES)[number];

export const COMMAND_CENTER_SHIFTS = ["morning", "evening"] as const;
export type CommandCenterShift = (typeof COMMAND_CENTER_SHIFTS)[number];

export type CommandCenterSourceSystem = "meta" | "creative";
export type CommandCenterSourceType =
  | "meta_adset_decision"
  | "meta_budget_shift"
  | "meta_geo_decision"
  | "meta_placement_anomaly"
  | "meta_no_touch_item"
  | "creative_primary_decision";

export type CommandCenterPriority = "critical" | "high" | "medium" | "low";
export type CommandCenterFeedbackType =
  | "false_positive"
  | "bad_recommendation"
  | "false_negative";
export type CommandCenterFeedbackScope = "action" | "queue_gap";
export type CommandCenterSlaStatus = "on_track" | "due_soon" | "overdue" | "n_a";
export type CommandCenterQueueSectionKey =
  | "default_queue"
  | "overflow_backlog"
  | "watchlist"
  | "archive_context"
  | "history_context";
export type CommandCenterWorkloadClass =
  | "budget_shift"
  | "scale_promotion"
  | "recovery"
  | "creative_refresh"
  | "test_backlog"
  | "geo_review"
  | "risk_triage"
  | "policy_guardrail"
  | "protected_watch"
  | "archive_context";
export type CommandCenterBatchReviewClass =
  | "budget_shift"
  | "creative_refresh"
  | "test_backlog";
export type CommandCenterFeedbackOutcome =
  | "calibration_candidate"
  | "workflow_gap"
  | "operator_note";

const COMMAND_CENTER_SOURCE_TYPES = [
  "meta_adset_decision",
  "meta_budget_shift",
  "meta_geo_decision",
  "meta_placement_anomaly",
  "meta_no_touch_item",
  "creative_primary_decision",
] as const satisfies ReadonlyArray<CommandCenterSourceType>;

const COMMAND_CENTER_SLA_STATUSES = [
  "on_track",
  "due_soon",
  "overdue",
  "n_a",
] as const satisfies ReadonlyArray<CommandCenterSlaStatus>;

const COMMAND_CENTER_QUEUE_SECTION_KEYS = [
  "default_queue",
  "overflow_backlog",
  "watchlist",
  "archive_context",
  "history_context",
] as const satisfies ReadonlyArray<CommandCenterQueueSectionKey>;

const COMMAND_CENTER_WORKLOAD_CLASSES = [
  "budget_shift",
  "scale_promotion",
  "recovery",
  "creative_refresh",
  "test_backlog",
  "geo_review",
  "risk_triage",
  "policy_guardrail",
  "protected_watch",
  "archive_context",
] as const satisfies ReadonlyArray<CommandCenterWorkloadClass>;

export interface CommandCenterActionEvidence {
  label: string;
  value: string;
  impact?: "positive" | "negative" | "mixed" | "neutral";
}

export interface CommandCenterActionRelatedEntity {
  type: "campaign" | "adset" | "geo" | "placement" | "creative" | "family";
  id: string;
  label: string;
}

export interface CommandCenterActionSourceContext {
  sourceLabel: "Meta Decision OS" | "Creative Decision OS";
  operatingMode: string | null;
  sourceDeepLink: string;
  sourceDecisionId: string;
}

export interface CommandCenterActionCalibrationHint {
  channel: BusinessDecisionCalibrationChannel;
  objectiveFamily: BusinessDecisionObjectiveFamily | null;
  bidRegime: BusinessDecisionBidRegime | null;
  archetype: string | null;
  actionCeiling: string | null;
  matchedProfileKey: string | null;
}

export interface CommandCenterActionThroughput {
  priorityScore: number;
  actionable: boolean;
  defaultQueueEligible: boolean;
  selectedInDefaultQueue: boolean;
  ageHours: number;
  ageLabel: string;
  ageAnchorAt: string;
  slaTargetHours: number | null;
  slaStatus: CommandCenterSlaStatus;
}

export interface CommandCenterAction {
  actionFingerprint: string;
  provenance?: OperatorDecisionProvenance | null;
  sourceSystem: CommandCenterSourceSystem;
  sourceType: CommandCenterSourceType;
  surfaceLane: DecisionSurfaceLane;
  queueSection: CommandCenterQueueSectionKey;
  workloadClass: CommandCenterWorkloadClass;
  truthState: DecisionTruthState;
  operatorDisposition: DecisionOperatorDisposition;
  trustReasons: string[];
  title: string;
  recommendedAction: string;
  confidence: number;
  priority: CommandCenterPriority;
  summary: string;
  decisionSignals: string[];
  evidence: CommandCenterActionEvidence[];
  policyExplanation?: DecisionPolicyExplanation | null;
  guardrails: string[];
  relatedEntities: CommandCenterActionRelatedEntity[];
  tags: string[];
  watchlistOnly: boolean;
  batchReviewClass: CommandCenterBatchReviewClass | null;
  batchReviewEligible: boolean;
  calibrationHint: CommandCenterActionCalibrationHint | null;
  status: CommandCenterActionStatus;
  assigneeUserId: string | null;
  assigneeName: string | null;
  snoozeUntil: string | null;
  latestNoteExcerpt: string | null;
  noteCount: number;
  lastMutatedAt: string | null;
  lastMutationId: string | null;
  createdAt: string;
  sourceContext: CommandCenterActionSourceContext;
  throughput: CommandCenterActionThroughput;
  operatorPolicy?: OperatorPolicyAssessment | null;
  operatorInstruction?: OperatorInstruction | null;
}

export interface CommandCenterOpportunityItem {
  opportunityId: string;
  sourceSystem: CommandCenterSourceSystem;
  kind: string;
  title: string;
  summary: string;
  recommendedAction: string;
  confidence: number;
  queueEligible: boolean;
  eligibilityTrace:
    | MetaOpportunityBoardItem["eligibilityTrace"]
    | CreativeOpportunityBoardItem["eligibilityTrace"];
  evidenceFloors: DecisionEvidenceFloor[];
  tags: string[];
  sourceContext: CommandCenterActionSourceContext;
}

export interface CommandCenterPermissions {
  canEdit: boolean;
  reason: string | null;
  role: MembershipRole;
}

export interface CommandCenterAssignableUser {
  userId: string;
  name: string;
  email: string;
  role: Extract<MembershipRole, "admin" | "collaborator">;
}

export interface CommandCenterJournalEntry {
  id: string;
  businessId: string;
  actionFingerprint: string;
  actionTitle: string;
  sourceSystem: CommandCenterSourceSystem;
  sourceType: CommandCenterSourceType;
  eventType: CommandCenterJournalEventType;
  actorUserId: string;
  actorName: string | null;
  actorEmail: string | null;
  message: string;
  note: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CommandCenterSavedViewDefinition {
  sourceTypes?: CommandCenterSourceType[];
  statuses?: CommandCenterActionStatus[];
  tags?: string[];
  watchlistOnly?: boolean;
  surfaceLanes?: DecisionSurfaceLane[];
  queueSections?: CommandCenterQueueSectionKey[];
  workloadClasses?: CommandCenterWorkloadClass[];
  slaStatuses?: CommandCenterSlaStatus[];
  batchReviewEligible?: boolean;
}

export interface CommandCenterSavedView {
  id: string;
  businessId: string;
  viewKey: string;
  name: string;
  definition: CommandCenterSavedViewDefinition;
  isBuiltIn: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CommandCenterViewStack {
  stackKey: "run_now" | "optimize" | "watch" | "history" | "custom";
  label: string;
  views: CommandCenterSavedView[];
}

export interface CommandCenterFeedbackEntry {
  id: string;
  businessId: string;
  clientMutationId: string;
  feedbackType: CommandCenterFeedbackType;
  outcome: CommandCenterFeedbackOutcome;
  scope: CommandCenterFeedbackScope;
  actionFingerprint: string | null;
  actionTitle: string | null;
  sourceSystem: CommandCenterSourceSystem | null;
  sourceType: CommandCenterSourceType | null;
  workloadClass: CommandCenterWorkloadClass | null;
  calibrationHint: CommandCenterActionCalibrationHint | null;
  viewKey: string | null;
  actorUserId: string;
  actorName: string | null;
  actorEmail: string | null;
  note: string;
  createdAt: string;
}

export interface CommandCenterFeedbackSummary {
  totalCount: number;
  falsePositiveCount: number;
  badRecommendationCount: number;
  falseNegativeCount: number;
  queueGapCount: number;
  calibrationCandidateCount: number;
  workflowGapCount: number;
  recentEntries: CommandCenterFeedbackEntry[];
}

export interface CommandCenterQueueSectionSummary {
  key: CommandCenterQueueSectionKey;
  label: string;
  headline: string;
  count: number;
  actionableCount: number;
}

export interface CommandCenterHistoricalSelectedWindow {
  startDate: string;
  endDate: string;
  note: string;
}

export interface CommandCenterHistoricalCampaignFamilySummary {
  family: MetaCampaignFamily;
  familyLabel: string;
  campaignCount: number;
  activeCampaignCount: number;
  spend: number;
  purchases: number;
  roas: number;
  summary: string;
}

export interface CommandCenterHistoricalHotspot {
  key: string;
  label: string;
  count: number;
  summary: string;
}

export interface CommandCenterSuppressionRates {
  actionCore: number;
  watchlist: number;
  archive: number;
  degraded: number;
}

export interface CommandCenterDecisionQualitySummary {
  actionableCount: number;
  selectedCount: number;
  overflowCount: number;
  queueGapCount: number;
  feedbackCount: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
  badRecommendationCount: number;
  suppressionRates: CommandCenterSuppressionRates;
  falsePositiveHotspots: CommandCenterHistoricalHotspot[];
  falseNegativeHotspots: CommandCenterHistoricalHotspot[];
}

export interface CommandCenterDegradedGuidance {
  degradedActionCount: number;
  missingInputs: string[];
  reasons: string[];
  summary: string;
}

export interface CommandCenterCalibrationSuggestion {
  key: string;
  priority: "high" | "medium" | "low";
  title: string;
  detail: string;
  evidence: string;
}

export interface CommandCenterHistoricalIntelligence {
  selectedWindow: CommandCenterHistoricalSelectedWindow;
  campaignFamilies: CommandCenterHistoricalCampaignFamilySummary[];
  decisionQuality: CommandCenterDecisionQualitySummary;
  degradedGuidance: CommandCenterDegradedGuidance;
  calibrationSuggestions: CommandCenterCalibrationSuggestion[];
}

export interface CommandCenterQueueBudgetSummary {
  totalBudget: number;
  quotas: Record<CommandCenterPriority, number>;
  selectedActionFingerprints: string[];
  overflowCount: number;
  actionableCount: number;
  selectedCount: number;
}

export interface CommandCenterOwnerWorkloadSummary {
  ownerUserId: string | null;
  ownerName: string;
  openCount: number;
  overdueCount: number;
  highPriorityCount: number;
  budgetedCount: number;
  isUnassigned: boolean;
}

export interface CommandCenterShiftDigest {
  generatedAt: string;
  headline: string;
  summary: string;
  blockers: string[];
  watchouts: string[];
  linkedActionFingerprints: string[];
}

export interface CommandCenterHandoff {
  id: string;
  businessId: string;
  shift: CommandCenterShift;
  summary: string;
  blockers: string[];
  watchouts: string[];
  linkedActionFingerprints: string[];
  fromUserId: string;
  fromUserName: string | null;
  toUserId: string | null;
  toUserName: string | null;
  acknowledgedAt: string | null;
  acknowledgedByUserId: string | null;
  acknowledgedByUserName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommandCenterMutationRequest {
  businessId: string;
  actionFingerprint: string;
  clientMutationId: string;
  mutation: CommandCenterActionMutation;
  assigneeUserId?: string | null;
  snoozeUntil?: string | null;
}

export interface CommandCenterBatchMutationRequest {
  businessId: string;
  actionFingerprints: string[];
  clientMutationId: string;
  mutation: Extract<
    CommandCenterActionMutation,
    "approve" | "reject" | "reopen" | "complete_manual"
  >;
  startDate?: string;
  endDate?: string;
}

export interface CommandCenterResponse {
  contractVersion: typeof COMMAND_CENTER_CONTRACT_VERSION;
  generatedAt: string;
  businessId: string;
  startDate: string;
  endDate: string;
  analyticsWindow: OperatorAnalyticsWindow;
  decisionWindows: OperatorDecisionWindows;
  historicalMemory: OperatorHistoricalMemory;
  decisionAsOf: string;
  activeViewKey: string | null;
  permissions: CommandCenterPermissions;
  commercialSummary?: import("@/src/types/business-commercial").BusinessCommercialCoverageSummary;
  authority?: DecisionSurfaceAuthority;
  summary: {
    totalActions: number;
    actionCoreCount: number;
    pendingCount: number;
    approvedCount: number;
    rejectedCount: number;
    snoozedCount: number;
    assignedCount: number;
    watchlistCount: number;
    archiveCount: number;
    degradedCount: number;
    sourceHealth: DecisionSourceHealthEntry[];
    readReliability: DecisionReadReliability;
  };
  opportunitySummary: {
    totalCount: number;
    queueEligibleCount: number;
    protectedCount: number;
    metaCount: number;
    creativeCount: number;
    headline: string;
  };
  throughput: CommandCenterQueueBudgetSummary;
  queueSections: CommandCenterQueueSectionSummary[];
  ownerWorkload: CommandCenterOwnerWorkloadSummary[];
  shiftDigest: CommandCenterShiftDigest;
  viewStacks: CommandCenterViewStack[];
  feedbackSummary: CommandCenterFeedbackSummary;
  historicalIntelligence: CommandCenterHistoricalIntelligence;
  actions: CommandCenterAction[];
  opportunities: CommandCenterOpportunityItem[];
  savedViews: CommandCenterSavedView[];
  journal: CommandCenterJournalEntry[];
  handoffs: CommandCenterHandoff[];
  feedback: CommandCenterFeedbackEntry[];
  assignableUsers: CommandCenterAssignableUser[];
}

export interface CommandCenterActionStateRecord {
  businessId: string;
  actionFingerprint: string;
  sourceSystem: CommandCenterSourceSystem;
  sourceType: CommandCenterSourceType;
  actionTitle: string;
  recommendedAction: string;
  workflowStatus: CommandCenterActionStatus;
  assigneeUserId: string | null;
  assigneeName: string | null;
  snoozeUntil: string | null;
  latestNoteExcerpt: string | null;
  noteCount: number;
  lastMutationId: string | null;
  lastMutatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommandCenterFeedbackDefaults {
  outcome: CommandCenterFeedbackOutcome;
  workloadClass: CommandCenterWorkloadClass | null;
  calibrationHint: CommandCenterActionCalibrationHint | null;
}

export const COMMAND_CENTER_BUILT_IN_VIEWS = [
  {
    viewKey: "today_priorities",
    name: "Today priorities",
    definition: {
      queueSections: ["default_queue"] satisfies CommandCenterQueueSectionKey[],
      statuses: ["pending", "approved", "failed"] satisfies CommandCenterActionStatus[],
    },
  },
  {
    viewKey: "overdue_queue",
    name: "Overdue queue",
    definition: {
      queueSections: [
        "default_queue",
        "overflow_backlog",
      ] satisfies CommandCenterQueueSectionKey[],
      slaStatuses: ["overdue"] satisfies CommandCenterSlaStatus[],
    },
  },
  {
    viewKey: "batch_review_ready",
    name: "Batch review ready",
    definition: {
      queueSections: [
        "default_queue",
        "overflow_backlog",
      ] satisfies CommandCenterQueueSectionKey[],
      batchReviewEligible: true,
    },
  },
  {
    viewKey: "budget_shifts",
    name: "Budget shifts",
    definition: {
      queueSections: [
        "default_queue",
        "overflow_backlog",
      ] satisfies CommandCenterQueueSectionKey[],
      workloadClasses: ["budget_shift"] satisfies CommandCenterWorkloadClass[],
    },
  },
  {
    viewKey: "scale_promotions",
    name: "Scale promotions",
    definition: {
      queueSections: [
        "default_queue",
        "overflow_backlog",
      ] satisfies CommandCenterQueueSectionKey[],
      workloadClasses: ["scale_promotion"] satisfies CommandCenterWorkloadClass[],
    },
  },
  {
    viewKey: "fatigue_refresh",
    name: "Fatigue refresh",
    definition: {
      queueSections: [
        "default_queue",
        "overflow_backlog",
      ] satisfies CommandCenterQueueSectionKey[],
      workloadClasses: ["creative_refresh"] satisfies CommandCenterWorkloadClass[],
    },
  },
  {
    viewKey: "test_backlog",
    name: "Test backlog",
    definition: {
      queueSections: [
        "default_queue",
        "overflow_backlog",
      ] satisfies CommandCenterQueueSectionKey[],
      workloadClasses: ["test_backlog"] satisfies CommandCenterWorkloadClass[],
    },
  },
  {
    viewKey: "recovery_queue",
    name: "Recovery queue",
    definition: {
      queueSections: [
        "default_queue",
        "overflow_backlog",
      ] satisfies CommandCenterQueueSectionKey[],
      workloadClasses: ["recovery"] satisfies CommandCenterWorkloadClass[],
    },
  },
  {
    viewKey: "high_risk_actions",
    name: "High-risk actions",
    definition: {
      queueSections: [
        "default_queue",
        "overflow_backlog",
      ] satisfies CommandCenterQueueSectionKey[],
      workloadClasses: ["risk_triage"] satisfies CommandCenterWorkloadClass[],
    },
  },
  {
    viewKey: "no_touch_surfaces",
    name: "No-touch surfaces",
    definition: {
      watchlistOnly: true,
      queueSections: ["watchlist"] satisfies CommandCenterQueueSectionKey[],
    },
  },
  {
    viewKey: "overflow_backlog",
    name: "Overflow backlog",
    definition: {
      queueSections: ["overflow_backlog"] satisfies CommandCenterQueueSectionKey[],
    },
  },
  {
    viewKey: "geo_issues",
    name: "Geo issues",
    definition: {
      queueSections: [
        "default_queue",
        "overflow_backlog",
      ] satisfies CommandCenterQueueSectionKey[],
      workloadClasses: ["geo_review"] satisfies CommandCenterWorkloadClass[],
    },
  },
  {
    viewKey: "promo_mode_watchlist",
    name: "Promo mode watchlist",
    definition: {
      queueSections: ["watchlist"] satisfies CommandCenterQueueSectionKey[],
      tags: ["promo_mode_watchlist"],
    },
  },
  {
    viewKey: "archive_context",
    name: "Archive context",
    definition: {
      queueSections: ["archive_context"] satisfies CommandCenterQueueSectionKey[],
    },
  },
] as const satisfies ReadonlyArray<{
  viewKey: string;
  name: string;
  definition: CommandCenterSavedViewDefinition;
}>;

export const COMMAND_CENTER_DEFAULT_QUEUE_BUDGET = 12;
export const COMMAND_CENTER_DEFAULT_QUEUE_QUOTAS = {
  critical: 4,
  high: 4,
  medium: 3,
  low: 1,
} as const satisfies Record<CommandCenterPriority, number>;

export const COMMAND_CENTER_PRIORITY_SCORE_WEIGHTS = {
  critical: 100,
  high: 80,
  medium: 55,
  low: 35,
} as const satisfies Record<CommandCenterPriority, number>;

export const COMMAND_CENTER_DEFAULT_QUEUE_WORKLOAD_CAP = Math.max(
  2,
  Math.ceil(COMMAND_CENTER_DEFAULT_QUEUE_BUDGET / 4),
);

export const COMMAND_CENTER_SLA_TARGET_HOURS = {
  critical: 4,
  high: 24,
  medium: 72,
  low: 168,
} as const satisfies Record<CommandCenterPriority, number>;

const STATUS_TRANSITIONS: Record<
  CommandCenterActionStatus,
  CommandCenterActionStatus[]
> = {
  pending: ["approved", "rejected", "snoozed", "canceled"],
  approved: ["completed_manual", "canceled", "failed"],
  rejected: ["pending"],
  snoozed: ["pending"],
  completed_manual: ["pending"],
  executed: [],
  failed: ["pending"],
  canceled: ["pending"],
};

function clampConfidence(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0.99, Number(value.toFixed(2))));
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function parseIsoTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatAgeLabel(ageHours: number) {
  if (!Number.isFinite(ageHours) || ageHours <= 0.25) return "fresh now";
  if (ageHours < 24) return `${Math.max(1, Math.round(ageHours))}h old`;
  const ageDays = ageHours / 24;
  if (ageDays < 7) return `${Math.max(1, Math.round(ageDays))}d old`;
  return `${Math.max(1, Math.round(ageDays / 7))}w old`;
}

function joinSignals(values: Array<string | null | undefined>) {
  return values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

function containsPromoSignal(value: string) {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("promo") ||
    normalized.includes("clearance") ||
    normalized.includes("sale") ||
    normalized.includes("launch")
  );
}

function evidenceFromMetrics(metrics: MetaAdSetDecision["supportingMetrics"]) {
  return [
    {
      label: "ROAS",
      value: `${metrics.roas.toFixed(2)}x`,
      impact: metrics.roas >= 2 ? "positive" : "negative",
    },
    {
      label: "Spend",
      value: `$${metrics.spend.toFixed(0)}`,
      impact: "neutral",
    },
    {
      label: "Purchases",
      value: `${metrics.purchases}`,
      impact: "neutral",
    },
  ] satisfies CommandCenterActionEvidence[];
}

function priorityFromMetaAdSet(decision: MetaAdSetDecision): CommandCenterPriority {
  if (decision.priority === "critical") return "critical";
  if (decision.priority === "high") return "high";
  if (decision.actionType === "pause" || decision.actionType === "rebuild") {
    return "high";
  }
  return decision.priority === "low" ? "low" : "medium";
}

function priorityFromCreative(creative: CreativeDecisionOsCreative): CommandCenterPriority {
  if (creative.primaryAction === "block_deploy") return "critical";
  if (
    creative.primaryAction === "refresh_replace" ||
    creative.primaryAction === "promote_to_scaling"
  ) {
    return "high";
  }
  if (creative.primaryAction === "hold_no_touch") return "low";
  return "medium";
}

function buildCalibrationProfileKey(
  profile: Pick<
    BusinessDecisionCalibrationProfile,
    "channel" | "objectiveFamily" | "bidRegime" | "archetype"
  >,
) {
  return [
    profile.channel,
    profile.objectiveFamily,
    profile.bidRegime,
    profile.archetype,
  ].join(":");
}

function resolveCalibrationProfileMatch(input: {
  channel: BusinessDecisionCalibrationChannel;
  objectiveFamily: BusinessDecisionObjectiveFamily | null;
  bidRegime: BusinessDecisionBidRegime | null;
  archetype: string | null;
  calibrationProfiles?: BusinessDecisionCalibrationProfile[];
}) {
  if (!input.objectiveFamily || !input.bidRegime || !input.archetype) {
    return null;
  }
  const matchedProfile = (input.calibrationProfiles ?? []).find(
    (profile) =>
      profile.channel === input.channel &&
      profile.objectiveFamily === input.objectiveFamily &&
      profile.bidRegime === input.bidRegime &&
      profile.archetype === input.archetype,
  );
  return matchedProfile ? buildCalibrationProfileKey(matchedProfile) : null;
}

function buildMetaAdSetCalibrationHint(input: {
  decision: MetaAdSetDecision;
  calibrationProfiles?: BusinessDecisionCalibrationProfile[];
}): CommandCenterActionCalibrationHint {
  return {
    channel: "meta",
    objectiveFamily: input.decision.policy.objectiveFamily,
    bidRegime: input.decision.policy.bidRegime,
    archetype: input.decision.policy.primaryDriver,
    actionCeiling: input.decision.policy.explanation?.actionCeiling ?? null,
    matchedProfileKey: resolveCalibrationProfileMatch({
      channel: "meta",
      objectiveFamily: input.decision.policy.objectiveFamily,
      bidRegime: input.decision.policy.bidRegime,
      archetype: input.decision.policy.primaryDriver,
      calibrationProfiles: input.calibrationProfiles,
    }),
  };
}

function buildCreativeCalibrationHint(input: {
  creative: CreativeDecisionOsCreative;
  calibrationProfiles?: BusinessDecisionCalibrationProfile[];
}): CommandCenterActionCalibrationHint | null {
  if (!input.creative.policy) return null;
  return {
    channel: "creative",
    objectiveFamily:
      (input.creative.policy.objectiveFamily as BusinessDecisionObjectiveFamily | null) ??
      null,
    bidRegime:
      (input.creative.policy.bidRegime as BusinessDecisionBidRegime | null) ?? null,
    archetype: input.creative.policy.primaryDriver,
    actionCeiling: input.creative.policy.explanation?.actionCeiling ?? null,
    matchedProfileKey: resolveCalibrationProfileMatch({
      channel: "creative",
      objectiveFamily:
        (input.creative.policy.objectiveFamily as BusinessDecisionObjectiveFamily | null) ??
        null,
      bidRegime:
        (input.creative.policy.bidRegime as BusinessDecisionBidRegime | null) ?? null,
      archetype: input.creative.policy.primaryDriver,
      calibrationProfiles: input.calibrationProfiles,
    }),
  };
}

function classifyCommandCenterWorkload(input: {
  sourceType: CommandCenterSourceType;
  recommendedAction: string;
  tags: string[];
  watchlistOnly: boolean;
  surfaceLane: DecisionSurfaceLane;
  operatorDisposition: DecisionOperatorDisposition;
}): CommandCenterWorkloadClass {
  if (input.surfaceLane === "archive_context") return "archive_context";
  if (input.watchlistOnly || input.operatorDisposition === "protected_watchlist") {
    return "protected_watch";
  }
  if (input.sourceType === "meta_budget_shift") return "budget_shift";
  if (input.sourceType === "meta_geo_decision") return "geo_review";
  if (
    input.recommendedAction === "recover" ||
    input.recommendedAction === "retest_comeback"
  ) {
    return "recovery";
  }
  if (
    input.recommendedAction === "refresh_replace" ||
    input.recommendedAction === "creative_refresh_required" ||
    input.tags.includes("fatigue_refresh")
  ) {
    return "creative_refresh";
  }
  if (
    input.recommendedAction === "scale_budget" ||
    input.recommendedAction === "promote_to_scaling" ||
    input.tags.includes("scale_promotions")
  ) {
    return "scale_promotion";
  }
  if (
    input.recommendedAction === "keep_in_test" ||
    input.recommendedAction === "rebuild" ||
    input.recommendedAction === "broaden" ||
    input.recommendedAction === "retest_comeback" ||
    input.tags.includes("test_backlog")
  ) {
    return "test_backlog";
  }
  if (
    input.recommendedAction === "pause" ||
    input.recommendedAction === "block_deploy" ||
    input.recommendedAction === "exception_review" ||
    input.recommendedAction === "cut" ||
    input.recommendedAction === "isolate" ||
    input.tags.includes("high_risk_actions")
  ) {
    return "risk_triage";
  }
  return "policy_guardrail";
}

function resolveCommandCenterBatchReviewClass(input: {
  sourceType: CommandCenterSourceType;
  recommendedAction: string;
  surfaceLane: DecisionSurfaceLane;
  truthState: DecisionTruthState;
}): CommandCenterBatchReviewClass | null {
  if (
    input.surfaceLane !== "action_core" ||
    input.truthState === "degraded_missing_truth"
  ) {
    return null;
  }
  if (input.sourceType === "meta_budget_shift") return "budget_shift";
  if (
    input.sourceType === "creative_primary_decision" &&
    input.recommendedAction === "refresh_replace"
  ) {
    return "creative_refresh";
  }
  if (
    input.sourceType === "creative_primary_decision" &&
    (input.recommendedAction === "keep_in_test" ||
      input.recommendedAction === "retest_comeback")
  ) {
    return "test_backlog";
  }
  return null;
}

function createActionFingerprint(base: {
  sourceSystem: CommandCenterSourceSystem;
  sourceType: CommandCenterSourceType;
  entityType: string;
  entityId: string;
  sourceDecisionId: string;
  recommendedAction: string;
  decisionAsOf: string;
}) {
  return buildOperatorActionFingerprint({
    version: "command-center-action-fingerprint.v1",
    decisionAsOf: base.decisionAsOf,
    sourceSystem: base.sourceSystem,
    sourceType: base.sourceType,
    entityType: base.entityType,
    entityId: base.entityId,
    sourceDecisionId: base.sourceDecisionId,
    recommendedAction: base.recommendedAction,
  }).replace(/^od_/, "cc_");
}

function buildCommandCenterActionPushEligibility(input: {
  action: CommandCenterAction;
  actionable: boolean;
  canApply: boolean;
  blockedReason?: string | null;
}) {
  const hasValidProvenance = hasValidCommandCenterExecutionProvenance(input.action);
  return buildOperatorDecisionPushEligibility({
    provenance: hasValidProvenance ? input.action.provenance : null,
    queueEligible: input.actionable && hasValidProvenance,
    canApply: input.canApply,
    canRollback: false,
    blockedReason: hasValidProvenance
      ? input.blockedReason ?? null
      : "Missing complete decision provenance.",
  });
}

const PUSH_READINESS_RESTRICTIVENESS: Record<
  OperatorInstruction["pushReadiness"],
  number
> = {
  blocked_from_push: 0,
  read_only_insight: 1,
  operator_review_required: 2,
  safe_to_queue: 3,
  eligible_for_push_when_enabled: 4,
};

function mostRestrictivePushReadiness(
  left: OperatorInstruction["pushReadiness"] | null | undefined,
  right: OperatorInstruction["pushReadiness"],
) {
  if (!left) return right;
  return PUSH_READINESS_RESTRICTIVENESS[left] <= PUSH_READINESS_RESTRICTIVENESS[right]
    ? left
    : right;
}

function canCommandCenterActionUseProviderApply(input: {
  action: CommandCenterAction;
  policy: OperatorPolicyAssessment | null;
  actionable: boolean;
}) {
  if (!input.actionable) return false;
  if (!hasValidCommandCenterExecutionProvenance(input.action)) return false;
  if (input.policy?.pushReadiness !== "eligible_for_push_when_enabled") return false;
  return (
    input.action.sourceSystem === "meta" &&
    input.action.sourceType === "meta_adset_decision" &&
    META_EXECUTION_SUPPORTED_ACTIONS.includes(
      input.action.recommendedAction as (typeof META_EXECUTION_SUPPORTED_ACTIONS)[number],
    )
  );
}

function expectedProvenanceEntityTypeForAction(
  action: Pick<CommandCenterAction, "sourceType">,
) {
  if (action.sourceType === "meta_adset_decision") return "adset";
  if (action.sourceType === "meta_budget_shift") return "budget_shift";
  if (action.sourceType === "meta_geo_decision") return "geo";
  if (action.sourceType === "meta_placement_anomaly") return "placement";
  if (action.sourceType === "meta_no_touch_item") return "campaign";
  if (action.sourceType === "creative_primary_decision") return "creative";
  return null;
}

export function hasValidCommandCenterExecutionProvenance(
  action: Pick<
    CommandCenterAction,
    "sourceContext" | "sourceSystem" | "sourceType" | "provenance"
  >,
) {
  const provenance = action.provenance ?? null;
  if (!provenance) return false;
  if (provenance.contractVersion !== "operator-decision-provenance.v1") return false;
  if (!provenance.actionFingerprint || !provenance.evidenceHash) return false;
  if (
    action.sourceType !== "creative_primary_decision" &&
    provenance.sourceDecisionId !== action.sourceContext.sourceDecisionId
  ) {
    return false;
  }
  if (provenance.sourceRowScope.system !== action.sourceSystem) return false;
  if (action.sourceType === "creative_primary_decision") {
    return (
      provenance.sourceRowScope.entityType === "creative" ||
      provenance.sourceRowScope.entityType === "family" ||
      provenance.sourceRowScope.entityType === "opportunity"
    );
  }
  const expectedEntityType = expectedProvenanceEntityTypeForAction(action);
  if (
    expectedEntityType &&
    provenance.sourceRowScope.entityType !== expectedEntityType
  ) {
    return false;
  }
  return Boolean(
    provenance.decisionAsOf &&
      provenance.sourceWindow?.key &&
      provenance.sourceWindow?.startDate &&
      provenance.sourceWindow?.endDate,
  );
}

function commandCenterInstructionQueueWarnings(input: {
  pushEligibility: OperatorDecisionPushEligibility;
  missingCreativePolicy: boolean;
  policyBlocksQueue: boolean;
  watchlistOnly: boolean;
  surfaceLane: DecisionSurfaceLane;
  policy: OperatorPolicyAssessment | null;
}) {
  if (input.pushEligibility.queueEligible) return [];
  const reason =
    input.pushEligibility.blockedReason ??
    (input.missingCreativePolicy
      ? "Creative operator policy is missing."
      : input.policyBlocksQueue
        ? input.policy?.blockers[0] ??
          input.policy?.explanation ??
          "Operator policy blocks queue eligibility."
        : input.watchlistOnly || input.surfaceLane !== "action_core"
          ? "Decision is contextual only."
          : "Final queue eligibility is blocked.");
  return [`Do not promote this Command Center card into queue work: ${reason}`];
}

function commandCenterAmountGuidance(
  action: Pick<CommandCenterAction, "sourceType" | "recommendedAction" | "evidence">,
): OperatorInstructionAmountGuidance | null {
  const moveBand = action.evidence.find((item) => item.label === "Move band")?.value;
  if (action.sourceType === "meta_budget_shift" && moveBand) {
    return {
      status: "bounded_estimate",
      label: `Move band: ${moveBand}`,
      reason:
        "The Meta Decision OS supplied a bounded move band; operator review must confirm the final account edit.",
      assumptions: [
        "The move band comes from the deterministic Meta budget-shift row.",
        "This does not grant apply capability by itself.",
      ],
    };
  }
  return null;
}

function buildMetaSourceDeepLink(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  campaignId?: string | null;
}) {
  const params = new URLSearchParams({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  if (input.campaignId) {
    params.set("campaignId", input.campaignId);
  }
  return `/platforms/meta?${params.toString()}`;
}

function buildMetaAction(
  input: Omit<
    CommandCenterAction,
    | "actionFingerprint"
    | "queueSection"
    | "workloadClass"
    | "batchReviewClass"
    | "batchReviewEligible"
    | "status"
    | "assigneeUserId"
    | "assigneeName"
    | "snoozeUntil"
    | "latestNoteExcerpt"
    | "noteCount"
    | "lastMutatedAt"
    | "lastMutationId"
    | "createdAt"
    | "throughput"
    | "operatorInstruction"
  > & {
    entityType: string;
    entityId: string;
    provenance: OperatorDecisionProvenance | null;
    decisionAsOf: string;
    operatorPolicy?: OperatorPolicyAssessment | null;
  },
): CommandCenterAction {
  const workloadClass = classifyCommandCenterWorkload({
    sourceType: input.sourceType,
    recommendedAction: input.recommendedAction,
    tags: input.tags,
    watchlistOnly: input.watchlistOnly,
    surfaceLane: input.surfaceLane,
    operatorDisposition: input.operatorDisposition,
  });
  const batchReviewClass = resolveCommandCenterBatchReviewClass({
    sourceType: input.sourceType,
    recommendedAction: input.recommendedAction,
    surfaceLane: input.surfaceLane,
    truthState: input.truthState,
  });

  return {
    ...input,
    actionFingerprint: createActionFingerprint({
      sourceSystem: input.sourceSystem,
      sourceType: input.sourceType,
      entityType: input.entityType,
      entityId: input.entityId,
      sourceDecisionId: input.sourceContext.sourceDecisionId,
      recommendedAction: input.recommendedAction,
      decisionAsOf: input.decisionAsOf,
    }),
    provenance: input.provenance,
    queueSection: "history_context",
    workloadClass,
    batchReviewClass,
    batchReviewEligible: batchReviewClass != null,
    status: "pending",
    assigneeUserId: null,
    assigneeName: null,
    snoozeUntil: null,
    latestNoteExcerpt: null,
    noteCount: 0,
    lastMutatedAt: null,
    lastMutationId: null,
    createdAt: new Date().toISOString(),
    operatorPolicy: input.operatorPolicy ?? null,
    operatorInstruction: buildOperatorInstruction({
      sourceSystem: input.sourceSystem,
      sourceLabel: input.sourceContext.sourceLabel,
      policy: input.operatorPolicy ?? null,
      policyVersion:
        (input.operatorPolicy as { policyVersion?: string | null } | null | undefined)
          ?.policyVersion ?? null,
      targetScope: input.entityType,
      targetEntity: input.title,
      actionLabel: input.recommendedAction.replaceAll("_", " "),
      reason: input.summary,
      confidenceScore: input.confidence,
      trustState: input.truthState,
      operatorDisposition: input.operatorDisposition,
      evidenceSource:
        (input.operatorPolicy as { evidenceSource?: string | null } | null | undefined)
          ?.evidenceSource ?? null,
      provenance: input.provenance,
      nextObservation: [...input.guardrails, ...input.decisionSignals],
      requiresPolicyForQueue: input.sourceSystem === "creative",
      amountGuidance: commandCenterAmountGuidance(input),
      invalidActions:
        input.watchlistOnly ||
        (input.operatorPolicy
          ? input.operatorPolicy.queueEligible !== true
          : input.sourceSystem === "creative")
          ? ["Do not promote this Command Center card into queue work unless policy readiness allows it."]
          : [],
    }),
    throughput: {
      priorityScore: 0,
      actionable: false,
      defaultQueueEligible: false,
      selectedInDefaultQueue: false,
      ageHours: 0,
      ageLabel: "fresh now",
      ageAnchorAt: new Date().toISOString(),
      slaTargetHours: null,
      slaStatus: "n_a",
    },
  };
}

function metaAdSetTags(decision: MetaAdSetDecision) {
  const tags = new Set<string>();
  if (decision.actionType === "scale_budget") tags.add("scale_promotions");
  if (
    decision.actionType === "rebuild" ||
    decision.actionType === "broaden" ||
    decision.actionType === "recover"
  ) {
    tags.add("test_backlog");
  }
  if (
    decision.actionType === "pause" ||
    decision.actionType === "reduce_budget" ||
    decision.priority === "critical"
  ) {
    tags.add("high_risk_actions");
  }
  if (containsPromoSignal(decision.campaignName)) {
    tags.add("promo_mode_watchlist");
  }
  return Array.from(tags);
}

function creativeTags(creative: CreativeDecisionOsCreative) {
  const tags = new Set<string>();
  if (creative.primaryAction === "promote_to_scaling") tags.add("scale_promotions");
  if (
    creative.primaryAction === "keep_in_test" ||
    creative.primaryAction === "retest_comeback"
  ) {
    tags.add("test_backlog");
  }
  if (creative.primaryAction === "refresh_replace") tags.add("fatigue_refresh");
  if (creative.primaryAction === "block_deploy") tags.add("high_risk_actions");
  if (
    containsPromoSignal(creative.familyLabel) ||
    containsPromoSignal(creative.name)
  ) {
    tags.add("promo_mode_watchlist");
  }
  return Array.from(tags);
}

function metaEvidenceFromDecision(
  evidence: MetaDecisionEvidence[],
): CommandCenterActionEvidence[] {
  return evidence.map((item) => ({
    label: item.label,
    value: item.value,
    impact: item.impact,
  }));
}

function mapMetaOpportunityToCommandCenter(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  operatingMode: string | null;
  item: MetaOpportunityBoardItem;
}): CommandCenterOpportunityItem {
  const campaignEntity = input.item.relatedEntities.find(
    (entity) => entity.type === "campaign",
  );
  return {
    opportunityId: input.item.opportunityId,
    sourceSystem: "meta",
    kind: input.item.kind,
    title: input.item.title,
    summary: input.item.summary,
    recommendedAction: input.item.recommendedAction,
    confidence: input.item.confidence,
    queueEligible: input.item.queue.eligible,
    eligibilityTrace: input.item.eligibilityTrace,
    evidenceFloors: input.item.evidenceFloors,
    tags: input.item.tags,
    sourceContext: {
      sourceLabel: "Meta Decision OS",
      operatingMode: input.operatingMode,
      sourceDeepLink: buildMetaSourceDeepLink({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        campaignId: campaignEntity?.id ?? null,
      }),
      sourceDecisionId: input.item.opportunityId,
    },
  };
}

function mapCreativeOpportunityToCommandCenter(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  operatingMode: string | null;
  item: CreativeOpportunityBoardItem;
  creativeDecisionOs: CreativeDecisionOsV1Response;
}): CommandCenterOpportunityItem {
  const relatedCreatives = input.item.creativeIds.map((creativeId) =>
    input.creativeDecisionOs.creatives.find(
      (candidate) => candidate.creativeId === creativeId,
    ),
  );
  const missingCreativeRows = relatedCreatives.some((creative) => !creative);
  const missingOperatorPolicy = relatedCreatives.some(
    (creative) => creative && !creative.operatorPolicy,
  );
  const missingProvenance = relatedCreatives.some((creative) =>
    creative ? !hasCreativeCommandCenterProvenance(creative) : false,
  );
  const nonLiveEvidence = relatedCreatives.some((creative) =>
    creative ? !hasLiveCreativeCommandCenterEvidence(creative) : false,
  );
  const allCreativePoliciesEligible =
    relatedCreatives.length > 0 &&
    relatedCreatives.every(hasCreativeOpportunityQueueAuthority);
  const queueEligible = input.item.queue.eligible && allCreativePoliciesEligible;
  const policyBlockReason = missingCreativeRows
    ? "Creative opportunity is not queue eligible because a referenced creative row is missing."
    : missingOperatorPolicy
      ? "Creative opportunity is not queue eligible because a referenced creative row is missing operator policy."
      : missingProvenance
        ? "Creative opportunity is not queue eligible because a referenced creative row is missing required provenance."
        : nonLiveEvidence
          ? "Creative opportunity is not queue eligible because referenced creative evidence is not live."
          : "Creative opportunity is not queue eligible without a matching safe-to-queue row policy.";
  const policyFloor: DecisionEvidenceFloor = {
    key: "creative_operator_policy",
    label: "Creative operator policy",
    status: allCreativePoliciesEligible ? "met" : "blocked",
    current: allCreativePoliciesEligible ? "safe to queue" : "not queue eligible",
    required: "safe to queue",
    reason: allCreativePoliciesEligible ? null : policyBlockReason,
  };
  const eligibilityTrace = queueEligible
    ? input.item.eligibilityTrace
    : normalizeBlockedCreativeOpportunityTrace({
        trace: input.item.eligibilityTrace,
        reason: allCreativePoliciesEligible
          ? "Creative opportunity queue eligibility is blocked by upstream queue policy."
          : policyBlockReason,
      });

  return {
    opportunityId: input.item.opportunityId,
    sourceSystem: "creative",
    kind: input.item.kind,
    title: input.item.title,
    summary: input.item.summary,
    recommendedAction: input.item.recommendedAction,
    confidence: input.item.confidence,
    queueEligible,
    eligibilityTrace,
    evidenceFloors: [
      ...input.item.evidenceFloors.filter((floor) => floor.key !== policyFloor.key),
      policyFloor,
    ],
    tags: input.item.tags,
    sourceContext: {
      sourceLabel: "Creative Decision OS",
      operatingMode: input.operatingMode,
      sourceDeepLink: `/creatives?businessId=${encodeURIComponent(
        input.businessId,
      )}&startDate=${encodeURIComponent(input.startDate)}&endDate=${encodeURIComponent(
        input.endDate,
      )}&family=${encodeURIComponent(input.item.familyId)}`,
      sourceDecisionId: input.item.opportunityId,
    },
  };
}

function hasCreativeCommandCenterProvenance(
  creative: CreativeDecisionOsCreative,
): boolean {
  return (
    creative.provenance?.sourceRowScope?.system === "creative" &&
    creative.provenance.sourceRowScope?.entityType === "creative" &&
    Boolean(creative.provenance.actionFingerprint) &&
    Boolean(creative.provenance.evidenceHash) &&
    creative.provenance.actionFingerprint === creative.actionFingerprint &&
    creative.provenance.evidenceHash === creative.evidenceHash
  );
}

function hasLiveCreativeCommandCenterEvidence(
  creative: CreativeDecisionOsCreative,
): boolean {
  return (
    creative.evidenceSource === "live" &&
    creative.operatorPolicy?.evidenceSource === "live"
  );
}

function hasCreativeOpportunityQueueAuthority(
  creative: CreativeDecisionOsCreative | undefined,
): boolean {
  if (!creative) return false;
  const policy = creative.operatorPolicy ?? null;
  return (
    hasCreativeCommandCenterProvenance(creative) &&
    hasLiveCreativeCommandCenterEvidence(creative) &&
    policy?.queueEligible === true &&
    policy.pushReadiness === "safe_to_queue"
  );
}

function normalizeBlockedCreativeOpportunityTrace(input: {
  trace: CreativeOpportunityBoardItem["eligibilityTrace"];
  reason: string;
}): CreativeOpportunityBoardItem["eligibilityTrace"] {
  const blockedReasons = Array.from(
    new Set([...input.trace.blockedReasons, input.reason]),
  );
  const blockedEvidenceFloors = Array.from(
    new Set([...input.trace.evidenceFloors.blocked, input.reason]),
  );
  const verdict = input.trace.verdict === "protected" ? "protected" : "blocked";

  return {
    ...input.trace,
    verdict,
    evidenceFloors: {
      ...input.trace.evidenceFloors,
      blocked: blockedEvidenceFloors,
    },
    queueCompilerDecision:
      input.trace.queueCompilerDecision.includes(input.reason)
        ? input.trace.queueCompilerDecision
        : `${input.trace.queueCompilerDecision} ${input.reason}`,
    blockedReasons,
  };
}

export function buildCommandCenterOpportunities(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  metaDecisionOs: MetaDecisionOsV1Response | null;
  creativeDecisionOs: CreativeDecisionOsV1Response | null;
}) {
  const items: CommandCenterOpportunityItem[] = [];

  if (input.metaDecisionOs) {
    const operatingMode =
      input.metaDecisionOs.summary.operatingMode?.recommendedMode ?? null;
    for (const item of input.metaDecisionOs.opportunityBoard ?? []) {
      items.push(
        mapMetaOpportunityToCommandCenter({
          businessId: input.businessId,
          startDate: input.startDate,
          endDate: input.endDate,
          operatingMode,
          item,
        }),
      );
    }
  }

  if (input.creativeDecisionOs) {
    const operatingMode = input.creativeDecisionOs.summary.operatingMode ?? null;
    for (const item of input.creativeDecisionOs.opportunityBoard ?? []) {
      items.push(
        mapCreativeOpportunityToCommandCenter({
          businessId: input.businessId,
          startDate: input.startDate,
          endDate: input.endDate,
          operatingMode,
          item,
          creativeDecisionOs: input.creativeDecisionOs,
        }),
      );
    }
  }

  return items.sort(
    (left, right) =>
      Number(right.queueEligible) - Number(left.queueEligible) ||
      right.confidence - left.confidence ||
      left.title.localeCompare(right.title),
  );
}

export function aggregateCommandCenterActions(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  metaDecisionOs: MetaDecisionOsV1Response | null;
  creativeDecisionOs: CreativeDecisionOsV1Response | null;
  stateByFingerprint?: Map<string, CommandCenterActionStateRecord>;
  calibrationProfiles?: BusinessDecisionCalibrationProfile[];
}): CommandCenterAction[] {
  const generatedAt = new Date().toISOString();
  const actions: CommandCenterAction[] = [];

  if (input.metaDecisionOs) {
    const metaDecisionOs = input.metaDecisionOs;
    const operatingMode = metaDecisionOs.summary.operatingMode?.recommendedMode ?? null;

    metaDecisionOs.adSets.forEach((decision) => {
      actions.push(
        buildMetaAction({
          sourceSystem: "meta",
          sourceType: "meta_adset_decision",
          entityType: "adset",
          entityId: decision.adSetId,
          surfaceLane: decision.trust.surfaceLane,
          truthState: decision.trust.truthState,
          operatorDisposition: decision.trust.operatorDisposition,
          trustReasons: decision.trust.reasons,
          title: decision.adSetName,
          recommendedAction: decision.actionType,
          confidence: clampConfidence(decision.confidence),
          priority: priorityFromMetaAdSet(decision),
          summary:
            decision.reasons[0] ??
            `${decision.policy.strategyClass.replaceAll("_", " ")} for ${decision.adSetName}`,
          decisionSignals: joinSignals([
            ...decision.reasons,
            `Strategy ${decision.policy.strategyClass.replaceAll("_", " ")}`,
            `Primary driver ${decision.policy.primaryDriver.replaceAll("_", " ")}`,
            ...decision.policy.secondaryDrivers.map((driver) =>
              `Secondary driver ${driver.replaceAll("_", " ")}`,
            ),
            decision.policy.explanation?.compare.reason,
          ]),
          evidence: evidenceFromMetrics(decision.supportingMetrics),
          policyExplanation: decision.policy.explanation ?? null,
          calibrationHint: buildMetaAdSetCalibrationHint({
            decision,
            calibrationProfiles: input.calibrationProfiles,
          }),
          guardrails: decision.guardrails,
          relatedEntities: [
            {
              type: "campaign",
              id: decision.campaignId,
              label: decision.campaignName,
            },
            {
              type: "adset",
              id: decision.adSetId,
              label: decision.adSetName,
            },
          ],
          tags: metaAdSetTags(decision),
          watchlistOnly: decision.trust.surfaceLane === "watchlist",
          sourceContext: {
            sourceLabel: "Meta Decision OS",
            operatingMode,
            sourceDeepLink: buildMetaSourceDeepLink({
              businessId: input.businessId,
              startDate: input.startDate,
              endDate: input.endDate,
              campaignId: decision.campaignId,
            }),
            sourceDecisionId: decision.decisionId,
          },
          provenance:
            (decision as { provenance?: OperatorDecisionProvenance | null })
              .provenance ?? null,
          decisionAsOf: metaDecisionOs.decisionAsOf,
          operatorPolicy: decision.operatorPolicy ?? null,
        }),
      );
    });

    metaDecisionOs.budgetShifts.forEach((shift) => {
      actions.push(
        buildMetaAction({
          sourceSystem: "meta",
          sourceType: "meta_budget_shift",
          entityType: "campaign",
          entityId: `${shift.fromCampaignId}:${shift.toCampaignId}`,
          surfaceLane: "action_core",
          truthState: "live_confident",
          operatorDisposition: "standard",
          trustReasons: [shift.whyNow],
          title: `${shift.from} -> ${shift.to}`,
          recommendedAction: "budget_shift",
          confidence: clampConfidence(shift.confidence),
          priority: shift.riskLevel === "high" ? "high" : "medium",
          summary: shift.whyNow,
          decisionSignals: [shift.whyNow, shift.expectedBenefit],
          evidence: [
            {
              label: "Move band",
              value: shift.suggestedMoveBand,
              impact: "neutral",
            },
          ],
          guardrails: shift.guardrails,
          relatedEntities: [
            {
              type: "campaign",
              id: shift.fromCampaignId,
              label: shift.fromCampaignName,
            },
            {
              type: "campaign",
              id: shift.toCampaignId,
              label: shift.toCampaignName,
            },
          ],
          tags: [
            "budget_shifts",
            "scale_promotions",
            ...(containsPromoSignal(shift.from) || containsPromoSignal(shift.to)
              ? ["promo_mode_watchlist"]
              : []),
          ],
          watchlistOnly: false,
          calibrationHint: null,
          sourceContext: {
            sourceLabel: "Meta Decision OS",
            operatingMode,
            sourceDeepLink: buildMetaSourceDeepLink({
              businessId: input.businessId,
              startDate: input.startDate,
              endDate: input.endDate,
              campaignId: shift.toCampaignId,
            }),
            sourceDecisionId: `${shift.fromCampaignId}:${shift.toCampaignId}:budget_shift`,
          },
          provenance: shift.provenance,
          decisionAsOf: metaDecisionOs.decisionAsOf,
        }),
      );
    });

    metaDecisionOs.geoDecisions
      .filter((decision) => decision.queueEligible)
      .forEach((decision) => {
      actions.push(
        buildMetaAction({
          sourceSystem: "meta",
          sourceType: "meta_geo_decision",
          entityType: "geo",
          entityId: decision.geoKey,
          surfaceLane: decision.trust.surfaceLane,
          truthState: decision.trust.truthState,
          operatorDisposition: decision.trust.operatorDisposition,
          trustReasons: decision.trust.reasons,
          title: decision.label,
          recommendedAction: decision.action,
          confidence: clampConfidence(decision.confidence),
          priority:
            decision.action === "cut" || decision.action === "isolate"
              ? "high"
              : "medium",
          summary: decision.why,
          decisionSignals: [decision.why, ...decision.whatWouldChangeThisDecision],
          evidence: metaEvidenceFromDecision(decision.evidence),
          calibrationHint: null,
          guardrails: decision.guardrails,
          relatedEntities: [
            {
              type: "geo",
              id: decision.geoKey,
              label: decision.label,
            },
          ],
          tags: [
            "geo_issues",
            ...(decision.action === "cut" || decision.action === "isolate"
              ? ["high_risk_actions"]
              : []),
          ],
          watchlistOnly: decision.trust.surfaceLane === "watchlist",
          sourceContext: {
            sourceLabel: "Meta Decision OS",
            operatingMode,
            sourceDeepLink: buildMetaSourceDeepLink({
              businessId: input.businessId,
              startDate: input.startDate,
              endDate: input.endDate,
            }),
            sourceDecisionId: decision.geoKey,
          },
          provenance:
            (decision as { provenance?: OperatorDecisionProvenance | null })
              .provenance ?? null,
          decisionAsOf: metaDecisionOs.decisionAsOf,
        }),
      );
      });

    metaDecisionOs.placementAnomalies.forEach((anomaly) => {
      actions.push(
        buildMetaAction({
          sourceSystem: "meta",
          sourceType: "meta_placement_anomaly",
          entityType: "placement",
          entityId: anomaly.placementKey,
          surfaceLane: "action_core",
          truthState: "live_confident",
          operatorDisposition: "standard",
          trustReasons: [anomaly.note],
          title: anomaly.label,
          recommendedAction: anomaly.action,
          confidence: clampConfidence(anomaly.confidence),
          priority: anomaly.action === "exception_review" ? "high" : "medium",
          summary: anomaly.note,
          decisionSignals: [
            anomaly.note,
            ...anomaly.whatWouldChangeThisDecision,
          ],
          evidence: metaEvidenceFromDecision(anomaly.evidence),
          calibrationHint: null,
          guardrails: [],
          relatedEntities: [
            {
              type: "placement",
              id: anomaly.placementKey,
              label: anomaly.label,
            },
          ],
          tags: ["high_risk_actions"],
          watchlistOnly: false,
          sourceContext: {
            sourceLabel: "Meta Decision OS",
            operatingMode,
            sourceDeepLink: buildMetaSourceDeepLink({
              businessId: input.businessId,
              startDate: input.startDate,
              endDate: input.endDate,
            }),
            sourceDecisionId: `${anomaly.placementKey}:${anomaly.action}`,
          },
          provenance: anomaly.provenance,
          decisionAsOf: metaDecisionOs.decisionAsOf,
        }),
      );
    });

    metaDecisionOs.noTouchList.forEach((item) => {
      actions.push(
        metaNoTouchAction({
          businessId: input.businessId,
          startDate: input.startDate,
          endDate: input.endDate,
          operatingMode,
          item,
          generatedAt,
          provenance:
            (item as { provenance?: OperatorDecisionProvenance | null })
              .provenance ?? null,
          decisionAsOf: metaDecisionOs.decisionAsOf,
        }),
      );
    });
  }

  if (input.creativeDecisionOs) {
    const creativeDecisionOs = input.creativeDecisionOs;
    const operatingMode = creativeDecisionOs.summary.operatingMode ?? null;
    creativeDecisionOs.creatives.forEach((creative) => {
      const watchlistOnly = creative.primaryAction === "hold_no_touch";
      actions.push(
        buildMetaAction({
          sourceSystem: "creative",
          sourceType: "creative_primary_decision",
          entityType: "creative",
          entityId: creative.creativeId,
          surfaceLane: creative.trust.surfaceLane,
          truthState: creative.trust.truthState,
          operatorDisposition: creative.trust.operatorDisposition,
          trustReasons: creative.trust.reasons,
          title: creative.name,
          recommendedAction: creative.primaryAction,
          confidence: clampConfidence(creative.confidence),
          priority: priorityFromCreative(creative),
          summary: creative.summary,
          decisionSignals: joinSignals([
            ...creative.decisionSignals,
            creative.policy?.explanation?.compare.reason,
          ]),
          evidence: [
            {
              label: "Lifecycle",
              value: creative.lifecycleState.replaceAll("_", " "),
              impact: "neutral",
            },
            {
              label: "ROAS",
              value: `${creative.roas.toFixed(2)}x`,
              impact: creative.roas >= 2 ? "positive" : "negative",
            },
            {
              label: "Spend",
              value: `$${creative.spend.toFixed(0)}`,
              impact: "neutral",
            },
          ],
          policyExplanation: creative.policy?.explanation ?? null,
          calibrationHint: buildCreativeCalibrationHint({
            creative,
            calibrationProfiles: input.calibrationProfiles,
          }),
          guardrails: creative.deployment.constraints,
          relatedEntities: [
            {
              type: "family",
              id: creative.familyId,
              label: creative.familyLabel,
            },
            {
              type: "creative",
              id: creative.creativeId,
              label: creative.name,
            },
          ],
          tags: [
            ...creativeTags(creative),
            ...(watchlistOnly ? ["promo_mode_watchlist"] : []),
          ],
          watchlistOnly: creative.trust.surfaceLane === "watchlist" || watchlistOnly,
          sourceContext: {
            sourceLabel: "Creative Decision OS",
            operatingMode,
            sourceDeepLink: `/creatives?businessId=${encodeURIComponent(
              input.businessId,
            )}&startDate=${encodeURIComponent(input.startDate)}&endDate=${encodeURIComponent(
              input.endDate,
            )}&creative=${encodeURIComponent(creative.creativeId)}`,
            sourceDecisionId: creative.creativeId,
          },
          provenance:
            (creative as { provenance?: OperatorDecisionProvenance | null })
              .provenance ?? null,
          decisionAsOf: creativeDecisionOs.decisionAsOf,
          operatorPolicy: creative.operatorPolicy ?? null,
        }),
      );
    });
  }

  const deduped = actions.map((action) => {
    const state = input.stateByFingerprint?.get(action.actionFingerprint);
    if (!state) return action;
    return {
      ...action,
      status: state.workflowStatus,
      assigneeUserId: state.assigneeUserId,
      assigneeName: state.assigneeName,
      snoozeUntil: state.snoozeUntil,
      latestNoteExcerpt: state.latestNoteExcerpt,
      noteCount: state.noteCount,
      lastMutatedAt: state.lastMutatedAt,
      lastMutationId: state.lastMutationId,
      createdAt: state.createdAt ?? action.createdAt,
    };
  });

  return deduped.sort(compareCommandCenterActions);
}

function metaNoTouchAction(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  operatingMode: string | null;
  item: MetaNoTouchItem;
  generatedAt: string;
  provenance: OperatorDecisionProvenance | null;
  decisionAsOf: string;
}) {
  return {
    actionFingerprint: createActionFingerprint({
      sourceSystem: "meta",
      sourceType: "meta_no_touch_item",
      entityType: input.item.entityType,
      entityId: input.item.entityId,
      sourceDecisionId: input.item.entityId,
      recommendedAction: "hold_no_touch",
      decisionAsOf: input.decisionAsOf,
    }),
    provenance: input.provenance,
    sourceSystem: "meta",
    sourceType: "meta_no_touch_item",
    surfaceLane: "watchlist",
    queueSection: "watchlist",
    workloadClass: "protected_watch",
    truthState: "live_confident",
    operatorDisposition: "protected_watchlist",
    trustReasons: [input.item.reason],
    title: input.item.label,
    recommendedAction: "hold_no_touch",
    confidence: clampConfidence(input.item.confidence),
    priority: "low",
    summary: input.item.reason,
    decisionSignals: [input.item.reason],
    evidence: [],
    guardrails: input.item.guardrails,
    relatedEntities: [
      {
        type:
          input.item.entityType === "campaign"
            ? "campaign"
            : input.item.entityType === "adset"
              ? "adset"
              : "geo",
        id: input.item.entityId,
        label: input.item.label,
      },
    ],
    tags: ["promo_mode_watchlist"],
    watchlistOnly: true,
    batchReviewClass: null,
    batchReviewEligible: false,
    calibrationHint: null,
    status: "pending" as CommandCenterActionStatus,
    assigneeUserId: null,
    assigneeName: null,
    snoozeUntil: null,
    latestNoteExcerpt: null,
    noteCount: 0,
    lastMutatedAt: null,
    lastMutationId: null,
    createdAt: input.generatedAt,
    throughput: {
      priorityScore: 0,
      actionable: false,
      defaultQueueEligible: false,
      selectedInDefaultQueue: false,
      ageHours: 0,
      ageLabel: "fresh now",
      ageAnchorAt: input.generatedAt,
      slaTargetHours: null,
      slaStatus: "n_a",
    },
    sourceContext: {
      sourceLabel: "Meta Decision OS",
      operatingMode: input.operatingMode,
      sourceDeepLink: buildMetaSourceDeepLink({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        campaignId:
          input.item.entityType === "campaign" ? input.item.entityId : null,
      }),
      sourceDecisionId: input.item.entityId,
    },
  } satisfies CommandCenterAction;
}

const COMMAND_CENTER_ACTIONABLE_STATUSES = new Set<
  Extract<CommandCenterActionStatus, "pending" | "approved" | "failed">
>(["pending", "approved", "failed"]);

export function isCommandCenterActionActionable(action: CommandCenterAction) {
  return (
    action.surfaceLane === "action_core" &&
    COMMAND_CENTER_ACTIONABLE_STATUSES.has(
      action.status as Extract<
        CommandCenterActionStatus,
        "pending" | "approved" | "failed"
      >,
    )
  );
}

export function calculateCommandCenterPriorityScore(action: CommandCenterAction) {
  let score = COMMAND_CENTER_PRIORITY_SCORE_WEIGHTS[action.priority];
  score += Math.round(action.confidence * 20);
  if (action.status === "failed") score += 8;
  if (!action.assigneeUserId) score += 6;
  if (
    action.tags.includes("high_risk_actions") ||
    action.priority === "critical"
  ) {
    score += 5;
  }
  if (action.truthState === "degraded_missing_truth") {
    score -= 10;
  }
  if (action.watchlistOnly || action.surfaceLane !== "action_core") {
    score -= 25;
  }
  return score;
}

export function decorateCommandCenterActionsWithThroughput(input: {
  actions: CommandCenterAction[];
  decisionAsOf: string;
}): CommandCenterAction[] {
  const decisionAsOfTimestamp =
    parseIsoTimestamp(`${input.decisionAsOf}T00:00:00.000Z`) ?? Date.now();

  return input.actions.map((action) => {
    const ageAnchorAt =
      action.lastMutatedAt ?? action.createdAt ?? `${input.decisionAsOf}T00:00:00.000Z`;
    const ageAnchorTimestamp = parseIsoTimestamp(ageAnchorAt) ?? decisionAsOfTimestamp;
    const ageHours = Math.max(
      0,
      Number(((decisionAsOfTimestamp - ageAnchorTimestamp) / 3_600_000).toFixed(1)),
    );
    const policy = action.operatorPolicy ?? null;
    const missingCreativePolicy =
      action.sourceSystem === "creative" && !policy;
    const policyBlocksQueue = policy ? !policy.queueEligible : missingCreativePolicy;
    const actionable = isCommandCenterActionActionable(action) && !policyBlocksQueue;
    const priorityScore = calculateCommandCenterPriorityScore(action);
    const canApply = canCommandCenterActionUseProviderApply({
      action,
      policy,
      actionable,
    });
    const pushEligibility = buildCommandCenterActionPushEligibility({
      action,
      actionable,
      canApply,
      blockedReason: action.provenance
        ? missingCreativePolicy
          ? "Creative operator policy is missing, so queue and push eligibility are blocked."
          : policy?.blockers[0] ??
          (policyBlocksQueue
            ? policy?.explanation ?? "Operator policy blocks queue eligibility."
            : null) ??
          (action.watchlistOnly || action.surfaceLane !== "action_core"
          ? "Decision is contextual only."
            : null)
        : "Missing decision provenance.",
    });
    const slaTargetHours = actionable
      ? COMMAND_CENTER_SLA_TARGET_HOURS[action.priority]
      : null;
    const slaStatus: CommandCenterSlaStatus =
      slaTargetHours == null
        ? "n_a"
        : ageHours >= slaTargetHours
          ? "overdue"
          : ageHours >= slaTargetHours * 0.7
            ? "due_soon"
            : "on_track";
    const operatorInstruction = buildOperatorInstruction({
      sourceSystem: action.sourceSystem,
      sourceLabel: action.sourceContext.sourceLabel,
      policy,
      policyVersion:
        (policy as { policyVersion?: string | null } | null | undefined)
          ?.policyVersion ?? null,
      targetScope: action.sourceType,
      targetEntity: action.title,
      actionLabel: action.recommendedAction.replaceAll("_", " "),
      reason: action.summary,
      confidenceScore: action.confidence,
      trustState: action.truthState,
      operatorDisposition: action.operatorDisposition,
      evidenceSource:
        (policy as { evidenceSource?: string | null } | null | undefined)
          ?.evidenceSource ?? null,
      provenance: action.provenance ?? null,
      nextObservation: [...action.guardrails, ...action.decisionSignals],
      requiresPolicyForQueue: action.sourceSystem === "creative",
      amountGuidance: commandCenterAmountGuidance(action),
      pushReadinessOverride: mostRestrictivePushReadiness(
        policy?.pushReadiness,
        pushEligibility.level,
      ),
      queueEligibleOverride: pushEligibility.queueEligible,
      canApplyOverride: canApply && pushEligibility.canApply,
      invalidActions: commandCenterInstructionQueueWarnings({
        pushEligibility,
        missingCreativePolicy,
        policyBlocksQueue,
        watchlistOnly: action.watchlistOnly,
        surfaceLane: action.surfaceLane,
        policy,
      }),
    });

    return {
      ...action,
      operatorInstruction,
      throughput: {
        priorityScore,
        actionable,
        defaultQueueEligible: pushEligibility.queueEligible,
        selectedInDefaultQueue: false,
        ageHours,
        ageLabel: formatAgeLabel(ageHours),
        ageAnchorAt,
        slaTargetHours,
        slaStatus,
      },
    };
  });
}

function actionComparatorForBudget(
  left: CommandCenterAction,
  right: CommandCenterAction,
) {
  if (left.throughput.priorityScore !== right.throughput.priorityScore) {
    return right.throughput.priorityScore - left.throughput.priorityScore;
  }
  if (left.throughput.ageHours !== right.throughput.ageHours) {
    return right.throughput.ageHours - left.throughput.ageHours;
  }
  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }
  return left.title.localeCompare(right.title);
}

function resolveCommandCenterQueueSection(
  action: CommandCenterAction,
): CommandCenterQueueSectionKey {
  if (action.throughput.selectedInDefaultQueue) return "default_queue";
  if (action.surfaceLane === "watchlist") return "watchlist";
  if (action.surfaceLane === "archive_context") return "archive_context";
  if (action.throughput.actionable) return "overflow_backlog";
  return "history_context";
}

const COMMAND_CENTER_QUEUE_SECTION_META = {
  default_queue: {
    label: "Default queue",
    headline: "Actions that fit the current throughput budget.",
  },
  overflow_backlog: {
    label: "Overflow backlog",
    headline: "Actionable items that missed the current queue budget.",
  },
  watchlist: {
    label: "Watchlist",
    headline: "Protected or review-only items kept out of daily execution.",
  },
  archive_context: {
    label: "Archive context",
    headline: "Historical or immaterial rows retained for context only.",
  },
  history_context: {
    label: "History context",
    headline: "Non-actionable workflow history outside the active queue.",
  },
} as const satisfies Record<
  CommandCenterQueueSectionKey,
  { label: string; headline: string }
>;

export function buildCommandCenterDefaultQueueSummary(actions: CommandCenterAction[]) {
  const actionableActions = actions
    .filter((action) => action.throughput.defaultQueueEligible)
    .sort(actionComparatorForBudget);
  const remainingQuotas: Record<CommandCenterPriority, number> = {
    critical: COMMAND_CENTER_DEFAULT_QUEUE_QUOTAS.critical,
    high: COMMAND_CENTER_DEFAULT_QUEUE_QUOTAS.high,
    medium: COMMAND_CENTER_DEFAULT_QUEUE_QUOTAS.medium,
    low: COMMAND_CENTER_DEFAULT_QUEUE_QUOTAS.low,
  };
  const selectedFingerprints: string[] = [];
  const workloadCounts = new Map<CommandCenterWorkloadClass, number>();

  for (const action of actionableActions) {
    if (selectedFingerprints.length >= COMMAND_CENTER_DEFAULT_QUEUE_BUDGET) break;
    if (remainingQuotas[action.priority] <= 0) continue;
    const workloadCount = workloadCounts.get(action.workloadClass) ?? 0;
    if (workloadCount >= COMMAND_CENTER_DEFAULT_QUEUE_WORKLOAD_CAP) continue;
    selectedFingerprints.push(action.actionFingerprint);
    remainingQuotas[action.priority] -= 1;
    workloadCounts.set(action.workloadClass, workloadCount + 1);
  }

  if (selectedFingerprints.length < COMMAND_CENTER_DEFAULT_QUEUE_BUDGET) {
    for (const action of actionableActions) {
      if (selectedFingerprints.length >= COMMAND_CENTER_DEFAULT_QUEUE_BUDGET) break;
      if (selectedFingerprints.includes(action.actionFingerprint)) continue;
      selectedFingerprints.push(action.actionFingerprint);
    }
  }

  return {
    totalBudget: COMMAND_CENTER_DEFAULT_QUEUE_BUDGET,
    quotas: {
      critical: COMMAND_CENTER_DEFAULT_QUEUE_QUOTAS.critical,
      high: COMMAND_CENTER_DEFAULT_QUEUE_QUOTAS.high,
      medium: COMMAND_CENTER_DEFAULT_QUEUE_QUOTAS.medium,
      low: COMMAND_CENTER_DEFAULT_QUEUE_QUOTAS.low,
    },
    selectedActionFingerprints: selectedFingerprints,
    overflowCount: Math.max(0, actionableActions.length - selectedFingerprints.length),
    actionableCount: actionableActions.length,
    selectedCount: selectedFingerprints.length,
  } satisfies CommandCenterQueueBudgetSummary;
}

export function applyCommandCenterQueueSelection(input: {
  actions: CommandCenterAction[];
  throughput: CommandCenterQueueBudgetSummary;
}) {
  const selected = new Set(input.throughput.selectedActionFingerprints);
  return input.actions.map((action) => {
    const selectedInDefaultQueue = selected.has(action.actionFingerprint);
    const nextAction = {
      ...action,
      throughput: {
        ...action.throughput,
        selectedInDefaultQueue,
      },
    };
    return {
      ...nextAction,
      queueSection: resolveCommandCenterQueueSection(nextAction),
    };
  });
}

export function buildCommandCenterQueueSections(
  actions: CommandCenterAction[],
): CommandCenterQueueSectionSummary[] {
  return COMMAND_CENTER_QUEUE_SECTION_KEYS.map((key) => {
    const sectionActions = actions.filter((action) => action.queueSection === key);
    return {
      key,
      label: COMMAND_CENTER_QUEUE_SECTION_META[key].label,
      headline: COMMAND_CENTER_QUEUE_SECTION_META[key].headline,
      count: sectionActions.length,
      actionableCount: sectionActions.filter((action) => action.throughput.actionable)
        .length,
    } satisfies CommandCenterQueueSectionSummary;
  }).filter((section) => section.count > 0);
}

export function buildCommandCenterOwnerWorkload(input: {
  actions: CommandCenterAction[];
  throughput: CommandCenterQueueBudgetSummary;
}) {
  const selected = new Set(input.throughput.selectedActionFingerprints);
  const owners = new Map<string, CommandCenterOwnerWorkloadSummary>();

  const ensureOwner = (
    ownerUserId: string | null,
    ownerName: string,
    isUnassigned: boolean,
  ) => {
    const key = ownerUserId ?? "unassigned";
    const existing = owners.get(key);
    if (existing) return existing;
    const created = {
      ownerUserId,
      ownerName,
      openCount: 0,
      overdueCount: 0,
      highPriorityCount: 0,
      budgetedCount: 0,
      isUnassigned,
    } satisfies CommandCenterOwnerWorkloadSummary;
    owners.set(key, created);
    return created;
  };

  input.actions
    .filter((action) => action.throughput.actionable)
    .forEach((action) => {
      const owner = ensureOwner(
        action.assigneeUserId,
        action.assigneeName ?? (action.assigneeUserId ? "Assigned operator" : "Unassigned"),
        !action.assigneeUserId,
      );
      owner.openCount += 1;
      if (action.throughput.slaStatus === "overdue") owner.overdueCount += 1;
      if (action.priority === "critical" || action.priority === "high") {
        owner.highPriorityCount += 1;
      }
      if (selected.has(action.actionFingerprint)) owner.budgetedCount += 1;
    });

  return [...owners.values()].sort((left, right) => {
    if (left.isUnassigned !== right.isUnassigned) {
      return Number(right.isUnassigned) - Number(left.isUnassigned);
    }
    if (left.overdueCount !== right.overdueCount) {
      return right.overdueCount - left.overdueCount;
    }
    if (left.highPriorityCount !== right.highPriorityCount) {
      return right.highPriorityCount - left.highPriorityCount;
    }
    if (left.openCount !== right.openCount) {
      return right.openCount - left.openCount;
    }
    return left.ownerName.localeCompare(right.ownerName);
  });
}

const VIEW_STACK_LABELS = {
  run_now: "Run now",
  optimize: "Optimize",
  watch: "Watch",
  history: "History",
  custom: "Custom",
} as const satisfies Record<CommandCenterViewStack["stackKey"], string>;

function resolveCommandCenterViewStack(view: CommandCenterSavedView): CommandCenterViewStack["stackKey"] {
  if (!view.isBuiltIn) return "custom";
  if (
    ["today_priorities", "overdue_queue", "batch_review_ready", "high_risk_actions"].includes(
      view.viewKey,
    )
  ) {
    return "run_now";
  }
  if (
    [
      "budget_shifts",
      "test_backlog",
      "scale_promotions",
      "fatigue_refresh",
      "recovery_queue",
      "geo_issues",
    ].includes(view.viewKey)
  ) {
    return "optimize";
  }
  if (["no_touch_surfaces", "promo_mode_watchlist"].includes(view.viewKey)) {
    return "watch";
  }
  return "history";
}

export function buildCommandCenterViewStacks(savedViews: CommandCenterSavedView[]) {
  const stacks = new Map<CommandCenterViewStack["stackKey"], CommandCenterSavedView[]>();
  for (const key of Object.keys(VIEW_STACK_LABELS) as CommandCenterViewStack["stackKey"][]) {
    stacks.set(key, []);
  }

  savedViews.forEach((view) => {
    stacks.get(resolveCommandCenterViewStack(view))?.push(view);
  });

  return (Object.keys(VIEW_STACK_LABELS) as CommandCenterViewStack["stackKey"][])
    .map((stackKey) => ({
      stackKey,
      label: VIEW_STACK_LABELS[stackKey],
      views: (stacks.get(stackKey) ?? []).sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    }))
    .filter((stack) => stack.views.length > 0);
}

export function summarizeCommandCenterFeedback(
  entries: CommandCenterFeedbackEntry[],
) {
  const recentEntries = [...entries]
    .sort((left, right) => {
      const leftTimestamp = Date.parse(String(left.createdAt));
      const rightTimestamp = Date.parse(String(right.createdAt));
      if (Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp)) {
        return rightTimestamp - leftTimestamp;
      }
      return String(right.createdAt).localeCompare(String(left.createdAt));
    })
    .slice(0, 8);

  return {
    totalCount: entries.length,
    falsePositiveCount: entries.filter((entry) => entry.feedbackType === "false_positive")
      .length,
    badRecommendationCount: entries.filter(
      (entry) => entry.feedbackType === "bad_recommendation",
    ).length,
    falseNegativeCount: entries.filter((entry) => entry.feedbackType === "false_negative")
      .length,
    queueGapCount: entries.filter((entry) => entry.scope === "queue_gap").length,
    calibrationCandidateCount: entries.filter(
      (entry) => entry.outcome === "calibration_candidate",
    ).length,
    workflowGapCount: entries.filter((entry) => entry.outcome === "workflow_gap").length,
    recentEntries,
  } satisfies CommandCenterFeedbackSummary;
}

export function buildCommandCenterFeedbackDefaults(input: {
  action?: CommandCenterAction | null;
  scope: CommandCenterFeedbackScope;
}): CommandCenterFeedbackDefaults {
  if (input.scope === "queue_gap") {
    return {
      outcome: "workflow_gap",
      workloadClass: null,
      calibrationHint: null,
    };
  }
  const action = input.action ?? null;
  if (!action) {
    return {
      outcome: "operator_note",
      workloadClass: null,
      calibrationHint: null,
    };
  }
  const hasCalibrationSignal = Boolean(
    action.calibrationHint?.objectiveFamily ||
      action.calibrationHint?.bidRegime ||
      action.calibrationHint?.archetype,
  );
  return {
    outcome: hasCalibrationSignal ? "calibration_candidate" : "operator_note",
    workloadClass: action.workloadClass,
    calibrationHint: action.calibrationHint,
  };
}

export function buildCommandCenterShiftDigest(input: {
  throughput: CommandCenterQueueBudgetSummary;
  actions: CommandCenterAction[];
  ownerWorkload: CommandCenterOwnerWorkloadSummary[];
  feedbackSummary: CommandCenterFeedbackSummary;
}) {
  const selectedSet = new Set(input.throughput.selectedActionFingerprints);
  const selectedActions = input.actions.filter((action) =>
    selectedSet.has(action.actionFingerprint),
  );
  const overdueCount = selectedActions.filter(
    (action) => action.throughput.slaStatus === "overdue",
  ).length;
  const unassignedCount = selectedActions.filter((action) => !action.assigneeUserId).length;
  const topOwner = input.ownerWorkload[0];
  const blockers: string[] = [];
  const watchouts: string[] = [];

  if (overdueCount > 0) {
    blockers.push(`${overdueCount} budgeted item(s) are already overdue.`);
  }
  if (unassignedCount > 0) {
    blockers.push(`${unassignedCount} budgeted item(s) are still unassigned.`);
  }
  if (input.throughput.overflowCount > 0) {
    watchouts.push(
      `${input.throughput.overflowCount} additional actionable item(s) overflowed the current shift budget.`,
    );
  }
  if (input.feedbackSummary.queueGapCount > 0) {
    watchouts.push(
      `${input.feedbackSummary.queueGapCount} queue-gap report(s) indicate missing work outside the surfaced queue.`,
    );
  }
  if (input.feedbackSummary.calibrationCandidateCount > 0) {
    watchouts.push(
      `${input.feedbackSummary.calibrationCandidateCount} feedback item(s) point to calibration tuning opportunities.`,
    );
  }
  const degradedCount = selectedActions.filter(
    (action) => action.truthState === "degraded_missing_truth",
  ).length;
  if (degradedCount > 0) {
    watchouts.push(
      `${degradedCount} budgeted item(s) are operating under degraded commercial truth.`,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    headline: `${input.throughput.selectedCount} actions fit the current shift budget.`,
    summary:
      topOwner != null
        ? `${topOwner.ownerName} carries the hottest workload with ${topOwner.openCount} open item(s).`
        : "No owner hotspots are active in the current queue.",
    blockers,
    watchouts,
    linkedActionFingerprints: selectedActions
      .slice(0, 6)
      .map((action) => action.actionFingerprint),
  } satisfies CommandCenterShiftDigest;
}

export function compareCommandCenterActions(
  left: CommandCenterAction,
  right: CommandCenterAction,
) {
  const statusWeight: Record<CommandCenterActionStatus, number> = {
    pending: 0,
    approved: 1,
    failed: 2,
    snoozed: 3,
    rejected: 4,
    canceled: 5,
    completed_manual: 6,
    executed: 7,
  };
  const priorityWeight: Record<CommandCenterPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  const queueSectionWeight: Record<CommandCenterQueueSectionKey, number> = {
    default_queue: 0,
    overflow_backlog: 1,
    watchlist: 2,
    archive_context: 3,
    history_context: 4,
  };

  const statusDelta = statusWeight[left.status] - statusWeight[right.status];
  if (statusDelta !== 0) return statusDelta;

  const queueDelta =
    queueSectionWeight[left.queueSection] - queueSectionWeight[right.queueSection];
  if (queueDelta !== 0) return queueDelta;

  const watchlistDelta = Number(left.watchlistOnly) - Number(right.watchlistOnly);
  if (watchlistDelta !== 0) return watchlistDelta;

  if (left.throughput.priorityScore !== right.throughput.priorityScore) {
    return right.throughput.priorityScore - left.throughput.priorityScore;
  }

  const priorityDelta = priorityWeight[left.priority] - priorityWeight[right.priority];
  if (priorityDelta !== 0) return priorityDelta;

  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }

  return left.title.localeCompare(right.title);
}

export function canTransitionCommandCenterStatus(
  from: CommandCenterActionStatus,
  to: CommandCenterActionStatus,
) {
  return STATUS_TRANSITIONS[from].includes(to);
}

export function resolveNextCommandCenterStatus(input: {
  currentStatus: CommandCenterActionStatus;
  mutation: CommandCenterActionMutation;
}) {
  switch (input.mutation) {
    case "approve":
      return "approved" satisfies CommandCenterActionStatus;
    case "reject":
      return "rejected" satisfies CommandCenterActionStatus;
    case "snooze":
      return "snoozed" satisfies CommandCenterActionStatus;
    case "reopen":
      return "pending" satisfies CommandCenterActionStatus;
    case "complete_manual":
      return "completed_manual" satisfies CommandCenterActionStatus;
    case "cancel":
      return "canceled" satisfies CommandCenterActionStatus;
    case "fail":
      return "failed" satisfies CommandCenterActionStatus;
    case "assign":
      return input.currentStatus;
  }
}

export function summarizeCommandCenterActions(actions: CommandCenterAction[]) {
  return {
    totalActions: actions.length,
    actionCoreCount: actions.filter((action) => action.surfaceLane === "action_core").length,
    pendingCount: actions.filter((action) => action.status === "pending").length,
    approvedCount: actions.filter((action) => action.status === "approved").length,
    rejectedCount: actions.filter((action) => action.status === "rejected").length,
    snoozedCount: actions.filter((action) => action.status === "snoozed").length,
    assignedCount: actions.filter((action) => Boolean(action.assigneeUserId)).length,
    watchlistCount: actions.filter((action) => action.surfaceLane === "watchlist").length,
    archiveCount: actions.filter((action) => action.surfaceLane === "archive_context").length,
    degradedCount: actions.filter(
      (action) => action.truthState === "degraded_missing_truth",
    ).length,
  };
}

export function summarizeCommandCenterOpportunities(
  opportunities: CommandCenterOpportunityItem[],
) {
  const queueEligibleCount = opportunities.filter(
    (item) => item.queueEligible,
  ).length;
  return {
    totalCount: opportunities.length,
    queueEligibleCount,
    protectedCount: opportunities.filter((item) =>
      item.kind.includes("protected"),
    ).length,
    metaCount: opportunities.filter((item) => item.sourceSystem === "meta").length,
    creativeCount: opportunities.filter((item) => item.sourceSystem === "creative").length,
    headline:
      queueEligibleCount > 0
        ? `${queueEligibleCount} opportunity-board item${queueEligibleCount > 1 ? "s are" : " is"} ready before it needs queue promotion.`
        : "Opportunity board is populated, but no item is queue-ready yet.",
  };
}

export function filterCommandCenterActionsByView(
  actions: CommandCenterAction[],
  definition: CommandCenterSavedViewDefinition,
) {
  return actions.filter((action) => {
    if (
      definition.watchlistOnly != null &&
      action.watchlistOnly !== definition.watchlistOnly
    ) {
      return false;
    }
    if (
      definition.surfaceLanes &&
      definition.surfaceLanes.length > 0 &&
      !definition.surfaceLanes.includes(action.surfaceLane)
    ) {
      return false;
    }
    if (
      definition.sourceTypes &&
      definition.sourceTypes.length > 0 &&
      !definition.sourceTypes.includes(action.sourceType)
    ) {
      return false;
    }
    if (
      definition.statuses &&
      definition.statuses.length > 0 &&
      !definition.statuses.includes(action.status)
    ) {
      return false;
    }
    if (
      definition.tags &&
      definition.tags.length > 0 &&
      !definition.tags.some((tag) => action.tags.includes(tag))
    ) {
      return false;
    }
    if (
      definition.queueSections &&
      definition.queueSections.length > 0 &&
      !definition.queueSections.includes(action.queueSection)
    ) {
      return false;
    }
    if (
      definition.workloadClasses &&
      definition.workloadClasses.length > 0 &&
      !definition.workloadClasses.includes(action.workloadClass)
    ) {
      return false;
    }
    if (
      definition.slaStatuses &&
      definition.slaStatuses.length > 0 &&
      !definition.slaStatuses.includes(action.throughput.slaStatus)
    ) {
      return false;
    }
    if (
      definition.batchReviewEligible != null &&
      action.batchReviewEligible !== definition.batchReviewEligible
    ) {
      return false;
    }
    return true;
  });
}

export function getBuiltInCommandCenterSavedViews(
  businessId: string,
): CommandCenterSavedView[] {
  return COMMAND_CENTER_BUILT_IN_VIEWS.map((view) => ({
    id: `builtin:${view.viewKey}`,
    businessId,
    viewKey: view.viewKey,
    name: view.name,
    definition: view.definition,
    isBuiltIn: true,
    createdAt: null,
    updatedAt: null,
  }));
}

export function buildCommandCenterViewKey(name: string) {
  return `custom_${slugify(name)}`;
}

export function sanitizeCommandCenterSavedViewDefinition(
  definition: unknown,
): CommandCenterSavedViewDefinition {
  const candidate =
    definition && typeof definition === "object"
      ? (definition as Record<string, unknown>)
      : {};

  const sourceTypes = Array.isArray(candidate.sourceTypes)
    ? candidate.sourceTypes.filter((value): value is CommandCenterSourceType =>
        typeof value === "string" &&
        COMMAND_CENTER_SOURCE_TYPES.includes(value as CommandCenterSourceType),
      )
    : undefined;

  const statuses = Array.isArray(candidate.statuses)
    ? candidate.statuses.filter((value): value is CommandCenterActionStatus =>
        typeof value === "string" &&
        COMMAND_CENTER_ACTION_STATUSES.includes(
          value as CommandCenterActionStatus,
        ),
      )
    : undefined;

  const tags = Array.isArray(candidate.tags)
    ? candidate.tags.filter((value): value is string => typeof value === "string")
    : undefined;

  const watchlistOnly =
    typeof candidate.watchlistOnly === "boolean"
      ? candidate.watchlistOnly
      : undefined;
  const surfaceLanes = Array.isArray(candidate.surfaceLanes)
    ? candidate.surfaceLanes.filter((value): value is DecisionSurfaceLane =>
        typeof value === "string" &&
        DECISION_SURFACE_LANES.includes(value as DecisionSurfaceLane),
      )
    : undefined;
  const queueSections = Array.isArray(candidate.queueSections)
    ? candidate.queueSections.filter((value): value is CommandCenterQueueSectionKey =>
        typeof value === "string" &&
        COMMAND_CENTER_QUEUE_SECTION_KEYS.includes(
          value as CommandCenterQueueSectionKey,
        ),
      )
    : undefined;
  const workloadClasses = Array.isArray(candidate.workloadClasses)
    ? candidate.workloadClasses.filter((value): value is CommandCenterWorkloadClass =>
        typeof value === "string" &&
        COMMAND_CENTER_WORKLOAD_CLASSES.includes(value as CommandCenterWorkloadClass),
      )
    : undefined;
  const slaStatuses = Array.isArray(candidate.slaStatuses)
    ? candidate.slaStatuses.filter((value): value is CommandCenterSlaStatus =>
        typeof value === "string" &&
        COMMAND_CENTER_SLA_STATUSES.includes(value as CommandCenterSlaStatus),
      )
    : undefined;
  const batchReviewEligible =
    typeof candidate.batchReviewEligible === "boolean"
      ? candidate.batchReviewEligible
      : undefined;

  return {
    ...(sourceTypes && sourceTypes.length > 0 ? { sourceTypes } : {}),
    ...(statuses && statuses.length > 0 ? { statuses } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(watchlistOnly != null ? { watchlistOnly } : {}),
    ...(surfaceLanes && surfaceLanes.length > 0 ? { surfaceLanes } : {}),
    ...(queueSections && queueSections.length > 0 ? { queueSections } : {}),
    ...(workloadClasses && workloadClasses.length > 0 ? { workloadClasses } : {}),
    ...(slaStatuses && slaStatuses.length > 0 ? { slaStatuses } : {}),
    ...(batchReviewEligible != null ? { batchReviewEligible } : {}),
  };
}

export function buildCommandCenterJournalMessage(input: {
  mutation: CommandCenterActionMutation | "note";
  actionTitle: string;
  nextStatus?: CommandCenterActionStatus;
  assigneeName?: string | null;
  snoozeUntil?: string | null;
}) {
  switch (input.mutation) {
    case "approve":
      return `Approved ${input.actionTitle}.`;
    case "reject":
      return `Rejected ${input.actionTitle}.`;
    case "reopen":
      return `Reopened ${input.actionTitle}.`;
    case "complete_manual":
      return `Marked ${input.actionTitle} as completed manually.`;
    case "cancel":
      return `Canceled ${input.actionTitle}.`;
    case "fail":
      return `Marked ${input.actionTitle} as failed.`;
    case "assign":
      return input.assigneeName
        ? `Assigned ${input.actionTitle} to ${input.assigneeName}.`
        : `Cleared assignee for ${input.actionTitle}.`;
    case "snooze":
      return input.snoozeUntil
        ? `Snoozed ${input.actionTitle} until ${input.snoozeUntil}.`
        : `Snoozed ${input.actionTitle}.`;
    case "note":
      return `Added a note to ${input.actionTitle}.`;
  }
}

export function buildCommandCenterActionStateOverlay(
  action: CommandCenterAction,
  state: CommandCenterActionStateRecord | null | undefined,
) {
  if (!state) return action;
  return {
    ...action,
    status: state.workflowStatus,
    assigneeUserId: state.assigneeUserId,
    assigneeName: state.assigneeName,
    snoozeUntil: state.snoozeUntil,
    latestNoteExcerpt: state.latestNoteExcerpt,
    noteCount: state.noteCount,
    lastMutatedAt: state.lastMutatedAt,
    lastMutationId: state.lastMutationId,
    createdAt: state.createdAt,
  };
}

export function isAssignableCommandCenterRole(
  role: string,
): role is Extract<MembershipRole, "admin" | "collaborator"> {
  return role === "admin" || role === "collaborator";
}

export function buildCommandCenterFiltersFromViewKey(
  businessId: string,
  viewKey: string | null | undefined,
  savedViews: CommandCenterSavedView[],
) {
  if (!viewKey) return null;
  const selected =
    savedViews.find((view) => view.viewKey === viewKey) ??
    getBuiltInCommandCenterSavedViews(businessId).find(
      (view) => view.viewKey === viewKey,
    );
  return selected?.definition ?? null;
}

export function buildCommandCenterSourceLabels(input: {
  action: CommandCenterAction;
}) {
  return joinSignals([
    input.action.sourceContext.sourceLabel,
    input.action.sourceContext.operatingMode
      ? `Operating Mode: ${input.action.sourceContext.operatingMode}`
      : null,
  ]);
}
