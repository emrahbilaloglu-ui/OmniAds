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

/** One KPI tile in the header strip, already reduced to what it displays. */
export interface DecisionCenterHeaderFact {
  key: "spend" | "roas" | "snapshot" | "labels" | "mode";
  label: string;
  value: string;
  /** Sits beside the value — a delta, a target, a percentage. */
  adjunct: string | null;
  note: string;
  chips: Array<{ text: string; tone: "ok" | "warn" | "neutral" }>;
  spark: number[] | null;
  tone: "accent" | "warn" | "neutral";
}

function pct(current: number | null | undefined, baseline: number | null | undefined) {
  if (typeof current !== "number" || typeof baseline !== "number") return null;
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) return null;
  const delta = ((current - baseline) / baseline) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}%`;
}

function count(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : null;
}

/**
 * The header KPI strip, projected from the account pulse the server measured.
 *
 * Arithmetic only over measured quantities — a percentage against a baseline,
 * a coverage ratio. Nothing here decides anything: no lane, no action, no
 * readiness. Where a measurement is absent the tile says "—" rather than 0,
 * because the strip is the first thing read and a fabricated zero there is
 * indistinguishable from a real one.
 */
export function decisionCenterHeaderFacts(input: {
  pacing?: {
    spendToday?: number;
    avg7dSpend?: number;
    conversionsToday?: number;
    avg7dConversions?: number;
  } | null;
  /**
   * `selected` is the ROAS for the window actually being shown. Reading `d28`
   * regardless would put a 28-day number under a "7d" heading.
   */
  roas?: { selected: number; d28: number; target: number | null } | null;
  roasHistory?: number[] | null;
  labelCoverage?: { activeCampaigns: number; labeledCampaigns: number } | null;
  operatingMode?: string | null;
  seasonalRegime?: string | null;
  trackingHealth?: { status: string; detail: string } | null;
  snapshotHealth?: { status: string; ageHours: number | null } | null;
  engineVersion?: string | null;
  lastSyncLabel?: string | null;
  currency?: string | null;
  windowLabel?: string | null;
  formatMoney: (value: number | null | undefined, currency: string | null) => string;
}): DecisionCenterHeaderFact[] {
  const pacing = input.pacing ?? null;
  const roas = input.roas ?? null;
  const coverage = input.labelCoverage ?? null;
  const snapshot = input.snapshotHealth ?? null;
  const tracking = input.trackingHealth ?? null;

  const spendDelta = pct(pacing?.spendToday, pacing?.avg7dSpend);
  const conversionsToday = count(pacing?.conversionsToday);
  const avg7dConversions = count(pacing?.avg7dConversions);

  const coverageRatio =
    coverage && coverage.activeCampaigns > 0
      ? Math.round((coverage.labeledCampaigns / coverage.activeCampaigns) * 100)
      : null;

  const snapshotAge =
    typeof snapshot?.ageHours === "number" && Number.isFinite(snapshot.ageHours)
      ? snapshot.ageHours < 1
        ? "under 1h old"
        : `${Math.round(snapshot.ageHours)}h old`
      : "age unknown";

  return [
    {
      key: "spend",
      label: "Spend · today",
      value: input.formatMoney(pacing?.spendToday, input.currency ?? null),
      adjunct: spendDelta ? `${spendDelta} vs 7d avg` : null,
      note:
        conversionsToday !== null
          ? `${conversionsToday} conversions${avg7dConversions !== null ? ` · 7d avg ${avg7dConversions}` : ""}`
          : "conversions not measured",
      chips: [],
      spark: null,
      tone: "neutral",
    },
    {
      key: "roas",
      label: `ROAS${input.windowLabel ? ` · ${input.windowLabel}` : ""}`,
      value:
        typeof roas?.selected === "number" && Number.isFinite(roas.selected)
          ? roas.selected.toFixed(2)
          : "—",
      adjunct:
        typeof roas?.target === "number" && Number.isFinite(roas.target)
          ? `target ${roas.target.toFixed(2)}`
          : "no target set",
      note: "",
      chips: [],
      spark: input.roasHistory?.length ? input.roasHistory : null,
      tone: "neutral",
    },
    {
      key: "snapshot",
      label: "Snapshot",
      value: "",
      adjunct: null,
      note: [
        input.engineVersion ? `engine ${input.engineVersion}` : null,
        input.lastSyncLabel ? `synced ${input.lastSyncLabel}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      chips: [
        {
          text: `${snapshot?.status ? snapshot.status.replace(/_/g, " ") : "unknown"} · ${snapshotAge}`,
          tone: snapshot?.status === "fresh" ? "ok" : "warn",
        },
      ],
      spark: null,
      tone: snapshot?.status === "fresh" ? "neutral" : "warn",
    },
    {
      key: "labels",
      label: "Labels",
      value: coverage ? `${coverage.labeledCampaigns}/${coverage.activeCampaigns}` : "—",
      adjunct: coverageRatio !== null ? `${coverageRatio}%` : null,
      note: coverage ? "" : "label coverage not measured",
      chips: [],
      spark: null,
      // Unlabelled campaigns are why decisions get capped, so partial coverage
      // is a warning rather than a neutral statistic.
      tone: coverageRatio !== null && coverageRatio < 100 ? "warn" : "neutral",
    },
    {
      key: "mode",
      label: "Mode",
      value: input.operatingMode ? titleCaseWord(input.operatingMode) : "—",
      adjunct: null,
      note: "",
      chips: [
        ...(input.seasonalRegime
          ? [{ text: titleCaseWord(input.seasonalRegime), tone: "neutral" as const }]
          : []),
        ...(tracking
          ? [
              {
                text: tracking.status === "healthy" ? "Tracking OK" : `Tracking ${tracking.status}`,
                tone: tracking.status === "healthy" ? ("ok" as const) : ("warn" as const),
              },
            ]
          : []),
      ],
      spark: null,
      tone: "neutral",
    },
  ];
}

function titleCaseWord(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
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
