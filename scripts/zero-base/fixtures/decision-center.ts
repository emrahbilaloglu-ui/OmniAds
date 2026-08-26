/**
 * A served Decision Center, for the frame and shell harnesses.
 *
 * The harnesses used to render `components/zero-base/_reference/
 * meta-decisions-view.tsx` — a body no route mounts. A green anatomy gate over
 * that body proves the leaf compiles; it proves nothing about the product,
 * because the product mounts `MetaDecisionCenterExact` through
 * `MetaPlatformPage`.
 *
 * So the fixture is a real `MetaDecisionsWorkspacePayload` put through the real
 * `buildMetaDecisionCenterExactViewModel`. Every marker the frames grade is
 * then emitted by the same adapter and the same component the route renders,
 * from a payload shaped like the one the route receives. Hand-writing a view
 * model would have been easier and would have graded a shape the server never
 * produces.
 *
 * The workflow overlay and the manual action are composed here rather than by
 * the adapter, for the same reason `MetaPlatformPage` composes them: they are
 * separate reads with their own lifecycles, and the adapter performs no fetch.
 */
import {
  buildMetaDecisionCenterExactViewModel,
} from "@/components/meta/decision-center/meta-decision-center-exact-adapter";
import type {
  MetaDecisionCenterExactViewModel,
  MetaDecisionCenterExactWorkflow,
} from "@/components/meta/decision-center/MetaDecisionCenterExact";
import type {
  MetaDecisionsWorkspacePayload,
} from "@/components/meta/redesign/types";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type {
  MetaOsDecisionsPresentation,
  MetaOsStructureNode,
} from "@/lib/meta/decisions-os-contract";

const PRIORITY = {
  band: "high",
  rank: 100,
  version: "meta-os-decisions.presentation.v5",
} as const;

const URGENCY = { level: "high", rank: 3, label: "High", reason: null } as const;

function recommendation(
  id: string,
  overrides: Partial<MetaRecommendation> = {},
): MetaRecommendation {
  return {
    id,
    level: "campaign",
    type: "campaign_state",
    lens: "profitability",
    priority: "high",
    confidence: "high",
    decisionState: "act",
    decisionLabel: "scale",
    decision: "Scale up — 7-day ROAS 3.4 vs target 2.6",
    title: "Prospecting — Broad US",
    why: "Seven-day ROAS is above target and pace is +18%.",
    summary: "",
    recommendedAction: "Raise the daily budget by 20%.",
    expectedImpact: "Roughly $1,900 more revenue at the same ROAS.",
    evidence: [],
    timeframeContext: {},
    campaignName: "Prospecting — Broad US",
    campaignId: "cmp_1",
    ...overrides,
  } as unknown as MetaRecommendation;
}

function node(
  recommendationId: string,
  lane: "act" | "blocked" | "monitor",
  confidence: "high" | "low" = "high",
): MetaOsStructureNode {
  return {
    id: `node_${recommendationId}`,
    sourceRecommendationId: recommendationId,
    level: "campaign",
    providerEntityId: "cmp_1",
    campaignId: "cmp_1",
    campaignName: "Prospecting — Broad US",
    name: "Prospecting — Broad US",
    lifecycleRole: "main",
    budgetOwner: "campaign",
    budgetMode: "campaign_budget",
    controlOwner: "campaign",
    status: "ACTIVE",
    optimizationGoal: "PURCHASE",
    action: {
      code: lane === "blocked" ? "review_authority" : "raise_budget",
      label:
        lane === "blocked" ? "Restore target authority" : "Raise daily budget",
      intent: lane === "blocked" ? "review" : "manual",
      targetLevel: "campaign",
      providerMutation: null,
      scopeNote:
        lane === "blocked"
          ? "Restore commercial target provenance before this can move."
          : "Review only in the existing guarded flow.",
    },
    lane,
    priority: PRIORITY,
    urgency: URGENCY,
    confidence: lane === "blocked" ? "low" : confidence,
    assessment: lane === "blocked" ? "Decision Blocked" : "Scale",
    whyNow:
      lane === "blocked"
        ? "Current commercial target authority is unavailable; the persisted verdict remains visible but cannot authorize an action."
        : "Seven-day ROAS is above target and pace is +18%.",
    expectedImpact: "Roughly $1,900 more revenue at the same ROAS.",
    evidence: [
      { label: "ROAS · 7d", value: "3.40", tone: "positive" },
      { label: "Spend · 7d", value: "$12,480", tone: "neutral" },
    ],
    metrics: {
      spend: 12480,
      purchases: 214,
      roas: 3.4,
      // Deliberately unserved at this grain: the inspector's provenance-gap
      // line is the marker H10 grades, and it can only appear when something
      // genuinely was not served.
      cpa: null,
      ctr: null,
      frequency: null,
      effectiveTargetRoas: 2.6,
      ratioToTarget: 1.31,
      currency: "USD",
      attribution: "meta_attributed",
      grain: "campaign_or_adset",
    },
    suppressedAlternativeCount: 0,
  } as unknown as MetaOsStructureNode;
}

function os(nodes: MetaOsStructureNode[]): MetaOsDecisionsPresentation {
  return {
    contractVersion: "meta-os-decisions.presentation.v5",
    generatedAt: "2026-08-09T06:10:00.000Z",
    source: {
      snapshotAsOf: "2026-08-09",
      engineVersion: "v3-2026-07-18",
      structureSource: "meta_recommendations",
      adsSource: "native_ad_decision",
      health: "healthy",
      fallbackReason: null,
    },
    structure: {
      groups: nodes.map((entry) => ({
        id: entry.id,
        campaign: entry,
        adsets: [],
        highestPriority: PRIORITY,
        highestUrgency: URGENCY,
        urgentAdsetCount: 0,
      })),
      actCount: nodes.filter((entry) => entry.lane === "act").length,
      blockedCount: nodes.filter((entry) => entry.lane === "blocked").length,
      monitorCount: nodes.filter((entry) => entry.lane === "monitor").length,
    },
    ads: { items: [], statePreCapCounts: { act: 0, blocked: 0, monitor: 0 } },
  } as unknown as MetaOsDecisionsPresentation;
}

function workspace(rows: number, blocked: number): MetaDecisionsWorkspacePayload {
  const actionNow = Array.from({ length: rows }, (_, index) =>
    recommendation(`d${index + 1}`, {
      title: `Prospecting — Broad US ${index + 1}`,
      confidence: index === rows - 1 ? "low" : "high",
      confidenceReason:
        index === rows - 1
          ? "Four days of data in a seven-day window."
          : null,
    } as Partial<MetaRecommendation>),
  );
  const blockedRows = Array.from({ length: blocked }, (_, index) =>
    recommendation(`b${index + 1}`, {
      title: `Retargeting — Lookalike ${index + 1}`,
      decisionLabel: "diagnose",
      decisionState: "act",
      recommendedAction: "",
    } as Partial<MetaRecommendation>),
  );
  const nodes = [
    /*
     * The last served row is low-confidence on purpose.
     *
     * `stale-demoted` is a marker H09 requires, and it can only appear on a row
     * the SERVER capped — so the fixture has to contain one, exactly as a real
     * account with stale evidence would.
     */
    ...actionNow.map((row, index) =>
      node(row.id, "act", index === actionNow.length - 1 ? "low" : "high"),
    ),
    ...blockedRows.map((row) => node(row.id, "blocked")),
  ];
  return {
    businessId: "biz",
    window: "28d",
    startDate: "2026-07-13",
    endDate: "2026-08-09",
    pulse: {
      businessId: "biz",
      window: "28d",
      startDate: "2026-07-13",
      endDate: "2026-08-09",
      pacing: {
        mtdSpend: 48213,
        mtdTarget: 60000,
        dayPace: 0.8,
        spendToday: 1840,
        avg7dSpend: 1600,
        conversionsToday: 41,
        avg7dConversions: 38,
      },
      roas: {
        selected: 3.4,
        d7: 3.4,
        d14: 3.1,
        d28: 3.0,
        target: 2.6,
        median: 2.4,
        target_source: "target_pack",
      },
      spend: { current: 48213, prev: 44120 },
      revenue: { current: 163924, prev: 138900 },
      cpa: { current: 24.1, prev: 25.9 },
      matureCampaigns: 8,
      learningCampaigns: 3,
      operatingMode: "Exploit",
      seasonalRegime: "normalized",
      engineLastRun: "2026-08-09T06:00:00.000Z",
      engineVersion: "v3-2026-07-18",
      trackingHealth: { status: "healthy", detail: "" },
      lastSyncAt: "2026-08-09T05:40:00.000Z",
      currency: "USD",
      labelCoverage: { labelled: 9, total: 11 },
    },
    lanes: {
      businessId: "biz",
      startDate: "2026-07-13",
      endDate: "2026-08-09",
      sourceModel: "snapshot_persistent",
      snapshotDate: "2026-08-09",
      snapshotCreatedAt: "2026-08-09T06:10:00.000Z",
      actionNow: [...actionNow, ...blockedRows],
      watching: [],
      healthy: [],
      nonSales: [],
      archive: [],
      structureInventory: [],
      deferredIds: [],
      counts: {
        actionNow: actionNow.length + blockedRows.length,
        watching: 0,
        healthy: 0,
        nonSales: 0,
        archive: 0,
      },
    },
    queue: { groups: [], actionStates: {} },
    system: {
      trackingBlocked: false,
      killSwitchEngaged: false,
      currency: "USD",
      engineVersion: "v3-2026-07-18",
      snapshotHealth: { status: "fresh", detail: "Written 06:10 UTC." },
    },
    viewer: {
      role: "collaborator",
      isReviewer: false,
      readOnly: false,
      readOnlyReason: null,
    },
    decisionReadModel: {
      status: "available",
      scope: { providerAccountId: "act_298410771", businessId: "biz" },
      source: {
        snapshotAsOf: "2026-08-09",
        engineVersion: "v3-2026-07-18",
        fallbackReason: null,
      },
    },
    os: os(nodes),
  } as unknown as MetaDecisionsWorkspacePayload;
}

/** The workflow overlay, as the page composes it onto the inspector. */
function workflow(conflict: boolean): MetaDecisionCenterExactWorkflow {
  return {
    state: "open",
    stateLabel: "Open",
    assignee: "—",
    holdUntil: "—",
    actions: [
      { id: "acknowledge", label: "Acknowledge", refusalReason: null, requires: [], onSelect: () => {} },
      { id: "assign", label: "Assign", refusalReason: null, requires: ["assignee"], onSelect: () => {} },
      { id: "defer", label: "Defer", refusalReason: null, requires: [], onSelect: () => {} },
      { id: "snooze", label: "Snooze", refusalReason: null, requires: ["snoozeUntil"], onSelect: () => {} },
      { id: "reject", label: "Reject", refusalReason: null, requires: ["reasonCode"], onSelect: () => {} },
      { id: "resolve", label: "Resolve", refusalReason: null, requires: [], onSelect: () => {} },
    ],
    actionsRefusedReason: null,
    menuRefusedReason: null,
    pending: false,
    conflict: conflict
      ? {
          currentStateLabel: "Acknowledged",
          currentVersion: 4,
          attemptedLabel: "Resolve",
          attemptedFromVersion: 3,
          message: "This decision changed while you were reading it.",
          keepRefusedReason: null,
          onKeepMine: () => {},
          onTakeServer: () => {},
        }
      : null,
  };
}

export interface DecisionCenterFixtureOptions {
  rows?: number;
  blocked?: number;
  /** Open the inspector on the first served row. */
  selected?: boolean;
  /** Render the version-conflict dialog (H12). */
  conflict?: boolean;
  /** Render the narrow terminus bar (H52/H57). */
  stickyBar?: boolean;
}

export function decisionCenterFixture(
  options: DecisionCenterFixtureOptions = {},
): MetaDecisionCenterExactViewModel {
  const rows = options.rows ?? 3;
  const blocked = options.blocked ?? 2;
  const payload = workspace(rows, blocked);
  const model = buildMetaDecisionCenterExactViewModel({
    workspace: payload,
    account: null,
    now: Date.parse("2026-08-09T12:00:00.000Z"),
    selection: options.selected
      ? { kind: "structure", recommendationId: "d1" }
      : null,
    callbacks: {
      onStructureMenu: () => {},
      onStructurePrimary: () => {},
      onWatchingReview: () => {},
      // A brief route exists, so the control is a link rather than a refusal.
      briefHref: (lineage) =>
        `/c/biz/creative/briefs?creativeId=${lineage.creativeId}`,
    },
  });
  /*
   * The ownership chip, attached exactly as the page attaches it.
   *
   * `MetaPlatformPage` composes it after the adapter has built the rows,
   * because the overlay is a separate read; the fixture does the same so the
   * frame grades the same composition the route produces.
   */
  const chip = {
    state: "acknowledged" as const,
    label: "Acknowledged",
    tone: "neutral" as const,
    detail: "Owner Dana Whitfield",
  };
  const withChips = {
    ...model,
    actionRows: (model.actionRows ?? []).map((row) => ({
      ...row,
      workflowChip: chip,
    })),
    needsResolutionRows: (model.needsResolutionRows ?? []).map((row) => ({
      ...row,
      workflowChip: chip,
    })),
  };
  if (!withChips.inspector) return withChips;
  const model2 = withChips;
  return {
    ...model2,
    inspector: {
      ...model2.inspector,
      workflow: workflow(options.conflict === true),
      ...(options.stickyBar
        ? { stickyBar: { metaStopHref: "/c/biz/meta/automation" } }
        : {}),
      manualAction: {
        label: "Open manual action",
        // The mutation gate ships closed, which is what the artboard draws:
        // present, refusing, and saying why.
        refusalReason:
          "The manual action sheet is not enabled on this workspace yet. The decision and its evidence are shown above.",
      },
    },
  };
}
