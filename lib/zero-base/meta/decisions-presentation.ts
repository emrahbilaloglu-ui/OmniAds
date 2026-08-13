/**
 * Decisions presentation adapter.
 *
 * This module is deliberately incapable of deciding anything. It selects,
 * filters and orders rows the server already produced, and copies their text
 * across byte-for-byte. It performs no arithmetic on a metric and derives no
 * verdict, because the Creative Decision Center's standing rule is that the UI
 * must not compute `buyerAction` — the server's resolution is the only truth,
 * and a surface that recomputes it will eventually disagree with it.
 *
 * Concretely, the rules it enforces:
 *
 * - verdict and metric strings are passed through, never reformatted;
 * - a blocked or held decision offers no action, whatever its label says;
 * - a reviewer or demo viewer offers no action at all;
 * - a metric that is not served at this grain renders as unavailable with its
 *   reason, never as zero.
 */
import type {
  MetaRecommendation,
  MetaRecommendationEvidence,
  MetaRecommendationRowPresentation,
} from "@/lib/meta/recommendations";
import type {
  MetaDecisionsWorkspaceBanner,
  MetaDecisionsWorkspaceViewer,
  MetaLanePayload,
} from "@/components/meta/redesign/types";
import type {
  MetaOsAdDecision,
  MetaOsDecisionLane,
  MetaOsDecisionsPresentation,
  MetaOsStructureNode,
} from "@/lib/meta/decisions-os-contract";
import {
  DECISION_LEVELS,
  type DecisionLane,
  type DecisionLevel,
  type DecisionsUrlState,
} from "@/lib/zero-base/meta/decisions-url-state";

export interface DecisionRow {
  id: string;
  level: DecisionLevel;
  /** Served title. Never re-derived from ids or metrics. */
  title: string;
  /** Served verdict text, byte-for-byte. */
  decision: string;
  why: string;
  recommendedAction: string;
  confidence: "high" | "medium" | "low";
  confidenceReason: string | null;
  decisionState: "act" | "test" | "watch";
  campaignName: string | null;
  adsetName: string | null;
  /** True when the server offers no action for this row. */
  held: boolean;
  heldReason: string | null;
  /** Server-served evidence strings; presentation may select them, never recompute them. */
  evidence?: readonly MetaRecommendationEvidence[];
  rowPresentation?: MetaRecommendationRowPresentation | null;
}

export interface DecisionsViewModel {
  rows: DecisionRow[];
  /** Rows in the served universe, before lane/level/search filtering. */
  servedIds: string[];
  counts: Record<DecisionLane, number>;
  banners: MetaDecisionsWorkspaceBanner[];
  viewer: MetaDecisionsWorkspaceViewer | null;
  evidenceWindow: { startDate: string; endDate: string };
  /** Engine write time. Deliberately distinct from the evidence window. */
  snapshotAt: string | null;
  snapshotDate: string | null;
  truncated: boolean;
  disclosure: string | null;
}

/**
 * A decision is held when the server says so.
 *
 * Read from the server's own fields — a null recommended action, or a state
 * reason — never inferred from label text. INVARIANTS is explicit that a
 * blocked resolution must not be recovered by parsing free-form reason strings.
 */
export function isHeld(recommendation: MetaRecommendation): boolean {
  const action = (recommendation.recommendedAction ?? "").trim();
  return action.length === 0 || recommendation.decisionState === "watch";
}

function toLevel(level: MetaRecommendation["level"]): DecisionLevel {
  return DECISION_LEVELS.includes(level as DecisionLevel) ? (level as DecisionLevel) : "campaign";
}

export function toDecisionRow(recommendation: MetaRecommendation): DecisionRow {
  const held = isHeld(recommendation);
  return {
    id: recommendation.id,
    level: toLevel(recommendation.level),
    // Every string below is copied, not composed.
    title: recommendation.title,
    decision: recommendation.decision,
    why: recommendation.why,
    recommendedAction: recommendation.recommendedAction,
    confidence: recommendation.confidence,
    confidenceReason: recommendation.confidenceReason ?? null,
    decisionState: recommendation.decisionState,
    campaignName: recommendation.campaignName ?? null,
    adsetName: recommendation.adsetName ?? null,
    held,
    heldReason: held ? (recommendation.stateReason ?? "No action is offered for this decision.") : null,
    evidence: recommendation.evidence ?? [],
    rowPresentation: recommendation.rowPresentation ?? null,
  };
}

/** Lane → the payload array the server serves it in. */
const LANE_SOURCE: Record<DecisionLane, keyof Pick<MetaLanePayload, "actionNow" | "watching" | "nonSales">> = {
  act: "actionNow",
  test: "nonSales",
  watch: "watching",
};

export function buildDecisionsViewModel(input: {
  lane: MetaLanePayload;
  banners: MetaDecisionsWorkspaceBanner[];
  viewer: MetaDecisionsWorkspaceViewer | null;
  state: DecisionsUrlState;
  cap?: number;
}): DecisionsViewModel {
  const cap = input.cap ?? 100;

  const laneRows = (input.lane[LANE_SOURCE[input.state.lane]] ?? []) as MetaRecommendation[];
  const all = laneRows.map(toDecisionRow);

  const byLevel =
    input.state.levels.length === 0
      ? all
      : all.filter((row) => input.state.levels.includes(row.level));

  const needle = input.state.search.trim().toLowerCase();
  const filtered = needle
    ? byLevel.filter((row) =>
        [row.title, row.campaignName, row.adsetName]
          .filter(Boolean)
          .some((text) => (text as string).toLowerCase().includes(needle)),
      )
    : byLevel;

  const served = filtered.slice(0, cap);
  const truncated = filtered.length > cap;

  return {
    rows: served,
    servedIds: served.map((row) => row.id),
    counts: {
      act: input.lane.counts?.actionNow ?? 0,
      test: input.lane.counts?.nonSales ?? 0,
      watch: input.lane.counts?.watching ?? 0,
    },
    banners: input.banners,
    viewer: input.viewer,
    evidenceWindow: { startDate: input.lane.startDate, endDate: input.lane.endDate },
    // The engine's write time, which is NOT the evidence window: a snapshot
    // written this morning can describe a window that ended three days ago,
    // and showing one as the other is how a stale read looks current.
    snapshotAt: input.lane.snapshotCreatedAt ?? null,
    snapshotDate: input.lane.snapshotDate ?? null,
    truncated,
    disclosure: truncated
      ? `Showing the first ${served.length} of ${filtered.length} decisions in this lane. Narrow by level or search to see the rest.`
      : null,
  };
}

const OS_LANE: Record<DecisionLane, MetaOsDecisionLane> = {
  act: "act",
  test: "blocked",
  watch: "monitor",
};

function osDecisionState(lane: MetaOsDecisionLane): DecisionRow["decisionState"] {
  return lane === "act" ? "act" : lane === "blocked" ? "test" : "watch";
}

function structureRow(node: MetaOsStructureNode): DecisionRow {
  const held = node.lane !== "act" || node.action.intent === "review" || node.action.intent === "none";
  return {
    id: node.id,
    level: node.level,
    title: node.name,
    decision: node.assessment,
    why: node.whyNow,
    recommendedAction: node.action.label,
    confidence: node.confidence === "unknown" ? "low" : node.confidence,
    confidenceReason: null,
    decisionState: osDecisionState(node.lane),
    campaignName: node.campaignName,
    adsetName: node.level === "adset" ? node.name : null,
    held,
    heldReason: held ? node.action.scopeNote : null,
    evidence: node.evidence,
    rowPresentation: { thumbLabel: node.level === "campaign" ? "C" : "A" },
  };
}

function adRow(decision: MetaOsAdDecision): DecisionRow {
  const held =
    decision.lane !== "act" ||
    decision.action.intent === "review" ||
    decision.action.intent === "none";
  return {
    id: decision.id,
    level: "ad",
    title: decision.adName,
    decision: decision.assessment,
    why: decision.whyNow,
    recommendedAction: decision.action.label,
    confidence: decision.confidence,
    confidenceReason: null,
    decisionState: osDecisionState(decision.lane),
    campaignName: decision.campaignName,
    adsetName: decision.adsetName,
    held,
    heldReason: held
      ? decision.resolution?.nextStep ?? decision.action.scopeNote
      : null,
    evidence: [],
    rowPresentation: { thumbLabel: "Ad" },
  };
}

/**
 * Route-owned Decisions consumes the canonical OS projection, not the legacy
 * recommendation arrays. Every row below is copied from the server-owned OS
 * contract; this adapter only filters and searches it.
 */
export function buildOsDecisionsViewModel(input: {
  os: MetaOsDecisionsPresentation;
  banners: MetaDecisionsWorkspaceBanner[];
  viewer: MetaDecisionsWorkspaceViewer | null;
  state: DecisionsUrlState;
  evidenceWindow: { startDate: string; endDate: string };
  cap?: number;
}): DecisionsViewModel {
  const cap = input.cap ?? 100;
  const structure = input.os.structure.groups.flatMap((group) => [
    structureRow(group.campaign),
    ...group.adsets.map(structureRow),
  ]);
  const ads = input.os.ads.items.map(adRow);
  const all = [...structure, ...ads];
  const requestedLane = OS_LANE[input.state.lane];
  const laneRows = all.filter((row) => {
    const lane = row.decisionState === "act" ? "act" : row.decisionState === "test" ? "blocked" : "monitor";
    return lane === requestedLane;
  });
  const byLevel =
    input.state.levels.length === 0
      ? laneRows
      : laneRows.filter((row) => input.state.levels.includes(row.level));
  const needle = input.state.search.trim().toLowerCase();
  const filtered = needle
    ? byLevel.filter((row) =>
        [row.title, row.campaignName, row.adsetName]
          .filter(Boolean)
          .some((text) => (text as string).toLowerCase().includes(needle)),
      )
    : byLevel;
  const rows = filtered.slice(0, cap);
  const counts = {
    act: input.os.ads.statePreCapCounts.act + input.os.structure.actCount,
    test: input.os.ads.statePreCapCounts.blocked + input.os.structure.blockedCount,
    watch: input.os.ads.statePreCapCounts.monitor + input.os.structure.monitorCount,
  };
  const sourceCount =
    counts[input.state.lane];
  const truncated = filtered.length > rows.length || sourceCount > laneRows.length;
  return {
    rows,
    servedIds: rows.map((row) => row.id),
    counts,
    banners: input.banners,
    viewer: input.viewer,
    evidenceWindow: input.evidenceWindow,
    snapshotAt: input.os.generatedAt,
    snapshotDate: input.os.source.snapshotAsOf,
    truncated,
    disclosure: truncated
      ? `Showing ${rows.length} served decisions. ${Math.max(sourceCount, filtered.length)} matched before presentation limits.`
      : null,
  };
}

/**
 * How many actions this viewer may take on a row.
 *
 * Always zero for a held decision, a reviewer, or a demo business — a demo has
 * zero Meta write authority even if a presentation defect supplied an action.
 */
export function actionCountFor(input: {
  row: DecisionRow;
  viewer: MetaDecisionsWorkspaceViewer | null;
  demo: boolean;
}): number {
  if (input.row.held) return 0;
  if (input.demo) return 0;
  if (input.viewer?.isReviewer) return 0;
  if (input.viewer?.readOnly) return 0;
  if (input.viewer?.role === "guest") return 0;
  return 1;
}

/** Hard and partial banners are both kept; severity orders, it does not filter. */
export function orderedBanners(
  banners: readonly MetaDecisionsWorkspaceBanner[],
): MetaDecisionsWorkspaceBanner[] {
  const blocking = banners.filter((banner) => banner.blocking);
  const advisory = banners.filter((banner) => !banner.blocking);
  return [...blocking, ...advisory];
}
