/**
 * What the Decision Center body is allowed to read, and what it may compute.
 *
 * The invariants are explicit (docs/meta-decision-center/INVARIANTS.md): the UI
 * renders backend-provided recommendations and must not compute buyer actions,
 * decision labels, label transforms, or automation readiness. So every function
 * here is either a pure projection of a server field or arithmetic over server
 * METRICS -- never over verdicts.
 *
 * The line that matters: summing `metrics.spend` across the act lane is money
 * the server already measured. Deciding that something belongs in the act lane
 * is the server's, and this module never re-derives it.
 */
import type {
  MetaOsAdDecision,
  MetaOsDecisionsPresentation,
  MetaOsStructureGroup,
  MetaOsStructureNode,
} from "@/lib/meta/decisions-os-contract";

export type DecisionCenterLayer = "structure" | "ads";

/** The reference's queue filters, in its order. */
export const DECISION_CENTER_QUEUES = [
  { key: "act", label: "Action Now" },
  { key: "monitor", label: "Watching" },
  { key: "blocked", label: "Blocked" },
] as const;

export type DecisionCenterQueueKey = (typeof DECISION_CENTER_QUEUES)[number]["key"];

/** One decision, flattened for the card list. Every field is server-sourced. */
export interface DecisionCenterItem {
  id: string;
  layer: DecisionCenterLayer;
  name: string;
  contextName: string | null;
  levelLabel: string;
  /** The server's verdict. Never recomputed here. */
  actionLabel: string;
  actionCode: string;
  actionIntent: string;
  scopeNote: string;
  lane: "act" | "blocked" | "monitor";
  confidence: "high" | "medium" | "low" | "unknown";
  assessment: string;
  whyNow: string;
  expectedImpact: string;
  evidence: Array<{ label: string; value: string; tone: "positive" | "warning" | "neutral" }>;
  spend: number | null;
  roas: number | null;
  targetRoas: number | null;
  currency: string | null;
  blockers: Array<{ code: string; label: string }>;
}

function fromStructureNode(
  node: MetaOsStructureNode,
  layer: DecisionCenterLayer,
): DecisionCenterItem {
  return {
    id: node.id,
    layer,
    name: node.name,
    contextName: node.campaignName,
    levelLabel: node.level === "campaign" ? "Campaign" : "Ad set",
    actionLabel: node.action.label,
    actionCode: node.action.code,
    actionIntent: node.action.intent,
    scopeNote: node.action.scopeNote,
    lane: node.lane,
    confidence: node.confidence,
    assessment: node.assessment,
    whyNow: node.whyNow,
    expectedImpact: node.expectedImpact,
    evidence: node.evidence,
    spend: node.metrics.spend,
    roas: node.metrics.roas,
    targetRoas: node.metrics.effectiveTargetRoas,
    currency: node.metrics.currency,
    blockers: [],
  };
}

function fromAdDecision(ad: MetaOsAdDecision): DecisionCenterItem {
  return {
    id: ad.id,
    layer: "ads",
    name: ad.adName,
    contextName: ad.campaignName ?? ad.adsetName,
    levelLabel: "Creative",
    actionLabel: ad.action.label,
    actionCode: ad.action.code,
    actionIntent: ad.action.intent,
    scopeNote: ad.action.scopeNote,
    lane: ad.lane,
    confidence: ad.confidence,
    assessment: ad.assessment,
    whyNow: ad.whyNow,
    expectedImpact: "",
    evidence: [],
    spend: null,
    roas: null,
    targetRoas: null,
    currency: null,
    blockers: ad.blockers,
  };
}

/**
 * Flatten the server presentation into the card list, campaign first with its
 * ad sets under it, in the order the server already ranked them.
 */
export function decisionCenterItems(
  presentation: MetaOsDecisionsPresentation,
  layer: DecisionCenterLayer,
): DecisionCenterItem[] {
  if (layer === "ads") {
    return presentation.ads.items.map(fromAdDecision);
  }
  const out: DecisionCenterItem[] = [];
  for (const group of presentation.structure.groups as MetaOsStructureGroup[]) {
    out.push(fromStructureNode(group.campaign, "structure"));
    for (const adset of group.adsets) out.push(fromStructureNode(adset, "structure"));
  }
  return out;
}

/** Lane counts exactly as the server reports them — not recounted from items. */
export function decisionCenterQueueCounts(
  presentation: MetaOsDecisionsPresentation,
  layer: DecisionCenterLayer,
): Record<DecisionCenterQueueKey, number> {
  const side = layer === "structure" ? presentation.structure : presentation.ads;
  return { act: side.actCount, monitor: side.monitorCount, blocked: side.blockedCount };
}

/**
 * Money already at stake in a lane.
 *
 * Arithmetic over `metrics.spend`, which the server measured. Null spends are
 * skipped rather than coerced to zero: a missing measurement is not $0, and
 * reporting it as $0 would understate the number an operator acts on.
 */
export function decisionCenterMoneyAtStake(
  items: DecisionCenterItem[],
  lane: "act" | "blocked" | "monitor",
): { total: number; measured: number; unmeasured: number; currency: string | null } {
  let total = 0;
  let measured = 0;
  let unmeasured = 0;
  let currency: string | null = null;
  for (const item of items) {
    if (item.lane !== lane) continue;
    if (typeof item.spend === "number" && Number.isFinite(item.spend)) {
      total += item.spend;
      measured += 1;
      currency = currency ?? item.currency;
    } else {
      unmeasured += 1;
    }
  }
  return { total, measured, unmeasured, currency };
}

/**
 * Whether the card may show a primary command button.
 *
 * `intent` is the server's routing decision. "none" and "review" mean the
 * server withheld a command, and the card must not offer one anyway.
 */
export function decisionCenterHasCommand(item: DecisionCenterItem): boolean {
  return item.lane === "act" && item.actionIntent !== "none" && item.actionIntent !== "review";
}
