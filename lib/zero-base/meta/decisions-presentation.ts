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
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type {
  MetaDecisionsWorkspaceBanner,
  MetaDecisionsWorkspaceViewer,
  MetaLanePayload,
} from "@/components/meta/redesign/types";
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
