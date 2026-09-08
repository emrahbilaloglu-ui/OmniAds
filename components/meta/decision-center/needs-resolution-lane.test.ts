/**
 * The Needs Resolution lane, proven against the server's own classification.
 *
 * The design draws three decision lanes — Act now, Needs resolution,
 * Monitoring — and `INVARIANTS.md:39-41` names the same three when it requires
 * candidate caps to "preserve representation for every non-empty Act Now, Needs
 * Resolution, and Monitoring lane". The server has always produced that
 * classification: `MetaOsDecisionLane` is `act | blocked | monitor`, and
 * `lib/meta/decisions-os-presentation.ts:1520-1527` sets `blocked` for a
 * `diagnose` label or a target-authority blocker.
 *
 * What was missing was a lane. A blocked row stayed in whichever legacy array
 * it arrived in, so a decision the engine had explicitly refused authority for
 * was drawn under "Action Now" — beside decisions that could be executed —
 * with a disabled button and no statement of what was holding it. On Grandmix
 * (`act_805150454596350`) that is the majority of the queue.
 *
 * Three properties are asserted here because all three can silently regress:
 *
 * 1. **the split is the server's.** Nothing is inferred from a label, a badge
 *    or a metric — INVARIANTS forbids exactly that — so a row with no OS node
 *    is NOT blocked, and the lane says why it cannot tell.
 * 2. **no row is lost and none is double-counted.** The three counters still
 *    sum to what the server served.
 * 3. **the counters do not move with a filter.** They are split over the
 *    payload's own arrays, never the search-filtered overrides the page passes.
 */
import { describe, expect, it, vi } from "vitest";

import { metaRec } from "@/components/meta/redesign/test-fixtures";
import type { MetaDecisionsWorkspacePayload } from "@/components/meta/redesign/types";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type {
  MetaOsDecisionsPresentation,
  MetaOsStructureNode,
} from "@/lib/meta/decisions-os-contract";

import { buildMetaDecisionCenterExactViewModel } from "./meta-decision-center-exact-adapter";

const PRIORITY = {
  band: "high",
  rank: 100,
  version: "meta-os-decisions.presentation.v5",
} as const;

function node(
  recommendationId: string,
  lane: "act" | "blocked" | "monitor",
  overrides: Partial<MetaOsStructureNode> = {},
): MetaOsStructureNode {
  return {
    id: `node_${recommendationId}`,
    sourceRecommendationId: recommendationId,
    level: "campaign",
    providerEntityId: "cmp_1",
    campaignId: "cmp_1",
    campaignName: "Campaign",
    name: "Campaign",
    lifecycleRole: "main",
    budgetOwner: "campaign",
    budgetMode: "campaign_budget",
    controlOwner: "campaign",
    status: "ACTIVE",
    optimizationGoal: "PURCHASE",
    action: {
      code: "review_budget",
      label: "Review Campaign Budget",
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
    urgency: { level: "high", rank: 3, label: "High", reason: null },
    confidence: "high",
    assessment: lane === "blocked" ? "Decision Blocked" : "Server assessment",
    whyNow: "Server why now",
    expectedImpact: "Server expected impact",
    evidence: [],
    metrics: {
      spend: 500,
      purchases: 12,
      roas: 4.2,
      cpa: null,
      ctr: null,
      frequency: null,
      effectiveTargetRoas: 3.5,
      ratioToTarget: 1.2,
      currency: null,
      attribution: "meta_attributed",
      grain: "campaign_or_adset",
    },
    suppressedAlternativeCount: 0,
    ...overrides,
  };
}

function os(nodes: MetaOsStructureNode[]): MetaOsDecisionsPresentation {
  return {
    contractVersion: "meta-os-decisions.presentation.v5",
    generatedAt: "2026-08-17T10:00:00.000Z",
    source: {
      snapshotAsOf: "2026-08-16",
      engineVersion: "server-engine-v1",
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
        highestUrgency: {
          level: "high",
          rank: 3,
          label: "High",
          reason: null,
        },
        urgentAdsetCount: 0,
      })),
      actCount: nodes.filter((entry) => entry.lane === "act").length,
      blockedCount: nodes.filter((entry) => entry.lane === "blocked").length,
      monitorCount: nodes.filter((entry) => entry.lane === "monitor").length,
    },
    ads: {
      items: [],
      statePreCapCounts: { act: 0, blocked: 0, monitor: 0 },
    },
  } as unknown as MetaOsDecisionsPresentation;
}

function workspace(input: {
  actionNow: MetaRecommendation[];
  watching?: MetaRecommendation[];
  nodes?: MetaOsStructureNode[];
  counts?: { actionNow?: number; watching?: number };
}): MetaDecisionsWorkspacePayload {
  const watching = input.watching ?? [];
  return {
    businessId: "biz_1",
    window: "28d",
    startDate: "2026-07-21",
    endDate: "2026-08-17",
    pulse: {
      businessId: "biz_1",
      window: "28d",
      startDate: "2026-07-21",
      endDate: "2026-08-17",
      pacing: { mtdSpend: 0, mtdTarget: 0, dayPace: 0 },
      roas: {
        selected: Number.NaN,
        d7: Number.NaN,
        d14: Number.NaN,
        d28: Number.NaN,
        target: null,
        median: null,
        target_source: "none",
      },
      spend: { current: 0, prev: 0 },
      revenue: { current: 0, prev: 0 },
      cpa: { current: null, prev: null },
      matureCampaigns: 0,
      learningCampaigns: 0,
      operatingMode: "",
      seasonalRegime: "",
      engineLastRun: null,
      engineVersion: "server-engine-v1",
      trackingHealth: { status: "unknown", detail: "" },
      lastSyncAt: null,
      currency: "USD",
    },
    lanes: {
      businessId: "biz_1",
      startDate: "2026-07-21",
      endDate: "2026-08-17",
      sourceModel: "snapshot_persistent",
      snapshotDate: "2026-08-16",
      snapshotCreatedAt: "2026-08-17T06:00:00.000Z",
      actionNow: input.actionNow,
      watching,
      healthy: [],
      nonSales: [],
      archive: [],
      deferredIds: [],
      counts: {
        actionNow: input.counts?.actionNow ?? input.actionNow.length,
        watching: input.counts?.watching ?? watching.length,
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
      engineVersion: "server-engine-v1",
      snapshotHealth: null,
    },
    decisionReadModel: {
      status: input.nodes ? "available" : "unavailable",
      scope: { providerAccountId: null },
      source: {
        snapshotAsOf: "2026-08-16",
        engineVersion: "server-engine-v1",
        fallbackReason: input.nodes ? null : "native_generation_unavailable",
      },
    },
    ...(input.nodes ? { os: os(input.nodes) } : {}),
  } as unknown as MetaDecisionsWorkspacePayload;
}

const build = (payload: MetaDecisionsWorkspacePayload, overrides?: unknown) =>
  buildMetaDecisionCenterExactViewModel({
    workspace: payload,
    account: null,
    now: Date.parse("2026-08-17T12:00:00.000Z"),
    ...(overrides ? { overrides } : {}),
  } as never);

describe("the lane is the server's classification, not the surface's", () => {
  it("moves a blocked row out of Action Now and into its own lane", () => {
    const rows = [
      metaRec({ id: "rec_open", title: "Open" }),
      metaRec({ id: "rec_blocked", title: "Blocked" }),
    ];
    const model = build(
      workspace({
        actionNow: rows,
        nodes: [node("rec_open", "act"), node("rec_blocked", "blocked")],
      }),
    );

    expect(model.actionRows?.map((row) => row.id)).toEqual(["rec_open"]);
    expect(model.needsResolutionRows?.map((row) => row.id)).toEqual([
      "rec_blocked",
    ]);
    expect(model.counts?.action).toBe(1);
    expect(model.counts?.needsres).toBe(1);
  });

  it("takes blocked rows from Watching too, and leaves the rest of Watching alone", () => {
    const model = build(
      workspace({
        actionNow: [metaRec({ id: "rec_a" })],
        watching: [metaRec({ id: "rec_w" }), metaRec({ id: "rec_wb" })],
        nodes: [
          node("rec_a", "act"),
          node("rec_w", "monitor"),
          node("rec_wb", "blocked"),
        ],
      }),
    );

    expect(model.watchingRows?.map((row) => row.id)).toEqual(["rec_w"]);
    expect(model.needsResolutionRows?.map((row) => row.id)).toEqual(["rec_wb"]);
    expect(model.counts?.watching).toBe(1);
    expect(model.counts?.needsres).toBe(1);
  });

  it("never infers blockedness from a label, a badge or a metric", () => {
    /*
     * `diagnose` is the label the producer maps to `blocked`, and this row
     * carries it — but its served node says `act`. The surface reads the node.
     * A UI that re-derived the state from the label would be the second
     * resolver INVARIANTS.md:11-12 exists to prevent, and it would disagree
     * with the server the moment the mapping changed.
     */
    const model = build(
      workspace({
        actionNow: [metaRec({ id: "rec_x", decisionLabel: "diagnose" })],
        nodes: [node("rec_x", "act")],
      }),
    );

    expect(model.needsResolutionRows).toEqual([]);
    expect(model.actionRows?.map((row) => row.id)).toEqual(["rec_x"]);
  });

  it("keeps an Act row's served action when readiness still carries blockers", () => {
    const recommendation = metaRec({
      id: "rec_act_with_readiness",
      decisionLabel: "rebuild",
      automationReadiness: {
        contractVersion: "meta-automation-readiness.v1",
        tier: "manual_review",
        autoExecuteEligible: false,
        operatorReviewRequired: true,
        decisionLabel: "rebuild",
        blockers: ["missing_commercial_anchor"],
        missingEvidence: ["commercial_target_or_breakeven"],
        requiredEvidence: ["commercial_target_or_breakeven"],
        reason: "Commercial evidence remains relevant to automation.",
      },
    });
    const servedAction = {
      code: "route_launchpad_rebuild",
      label: "Rebuild in Launchpad",
      intent: "launchpad" as const,
      targetLevel: "campaign" as const,
      providerMutation: null,
      scopeNote: "Open a paused rebuild draft.",
    };
    const onStructurePrimary = vi.fn();
    const model = buildMetaDecisionCenterExactViewModel({
      workspace: workspace({
        actionNow: [recommendation],
        nodes: [
          node(recommendation.id, "act", {
            action: servedAction,
          }),
        ],
      }),
      account: null,
      now: Date.parse("2026-08-17T12:00:00.000Z"),
      selection: {
        kind: "structure",
        recommendationId: recommendation.id,
      },
      callbacks: { onStructurePrimary },
    });

    expect(model.inspector).toMatchObject({
      serverVerdict: "Open rebuild draft",
      contractDetail: "Open a draft for review before anything is created.",
      actionLabel: "Open rebuild draft",
    });
    expect(model.inspector?.onPrimary).toBeTypeOf("function");
    model.inspector?.onPrimary?.();
    expect(onStructurePrimary).toHaveBeenCalledOnce();
    expect(onStructurePrimary).toHaveBeenCalledWith(
      recommendation,
      servedAction,
    );
  });

  it("keeps a Monitor row's served no-change action when readiness carries blockers", () => {
    const recommendation = metaRec({
      id: "rec_monitor_with_readiness",
      decisionLabel: "keep",
      automationReadiness: {
        contractVersion: "meta-automation-readiness.v1",
        tier: "manual_review",
        autoExecuteEligible: false,
        operatorReviewRequired: true,
        decisionLabel: "keep",
        blockers: ["missing_commercial_anchor"],
        missingEvidence: ["commercial_target_or_breakeven"],
        requiredEvidence: ["commercial_target_or_breakeven"],
        reason: "Commercial evidence remains relevant to automation.",
      },
    });
    const servedAction = {
      code: "no_current_intervention",
      label: "Keep monitoring",
      intent: "none" as const,
      targetLevel: "campaign" as const,
      providerMutation: null,
      scopeNote: "No current intervention.",
    };
    const onStructurePrimary = vi.fn();
    const model = buildMetaDecisionCenterExactViewModel({
      workspace: workspace({
        actionNow: [],
        watching: [recommendation],
        nodes: [
          node(recommendation.id, "monitor", {
            action: servedAction,
          }),
        ],
      }),
      account: null,
      now: Date.parse("2026-08-17T12:00:00.000Z"),
      selection: {
        kind: "structure",
        recommendationId: recommendation.id,
      },
      callbacks: { onStructurePrimary },
    });

    expect(model.inspector).toMatchObject({
      serverVerdict: "Keep monitoring",
      contractDetail: "No Meta change is planned.",
      actionLabel: "Keep monitoring",
    });
    expect(model.inspector?.onPrimary).toBeTypeOf("function");
    model.inspector?.onPrimary?.();
    expect(onStructurePrimary).toHaveBeenCalledWith(
      recommendation,
      servedAction,
    );
  });

  it("treats an unserved projection as unknown, not as zero blocked rows", () => {
    const model = build(workspace({ actionNow: [metaRec({ id: "rec_a" })] }));

    expect(model.needsResolutionRows).toEqual([]);
    expect(model.counts?.needsres).toBe(0);
    // The lane says the difference out loud rather than drawing an empty list.
    expect(model.needsResolutionNotice).toBe(
      "Decision status is unavailable. Refresh decisions and try again.",
    );
    expect(model.needsResolutionNotice).not.toContain(
      "native_generation_unavailable",
    );
  });

  it("says nothing extra when the projection was read and held no blocked row", () => {
    const model = build(
      workspace({
        actionNow: [metaRec({ id: "rec_a" })],
        nodes: [node("rec_a", "act")],
      }),
    );

    expect(model.needsResolutionNotice).toBeNull();
  });
});

describe("the counters stay the server's totals", () => {
  it("keeps the sum unchanged across the split", () => {
    const model = build(
      workspace({
        actionNow: [
          metaRec({ id: "a1" }),
          metaRec({ id: "a2" }),
          metaRec({ id: "a3" }),
        ],
        watching: [metaRec({ id: "w1" }), metaRec({ id: "w2" })],
        nodes: [
          node("a1", "act"),
          node("a2", "blocked"),
          node("a3", "blocked"),
          node("w1", "monitor"),
          node("w2", "blocked"),
        ],
      }),
    );

    expect(model.counts?.action).toBe(1);
    expect(model.counts?.needsres).toBe(3);
    expect(model.counts?.watching).toBe(1);
    expect(
      Number(model.counts?.action) +
        Number(model.counts?.needsres) +
        Number(model.counts?.watching),
    ).toBe(5);
  });

  it("does not move when the page passes a filtered override", () => {
    /*
     * The page narrows `overrides.actionNow` by search and level. If the
     * counters were split over the override, typing a letter would report that
     * the account had shrunk — which is the law
     * `components/meta/decision-center/scope-counter.test.ts` already holds for
     * the scope pills, applied to the lane pills.
     */
    const served = [
      metaRec({ id: "a1" }),
      metaRec({ id: "a2" }),
      metaRec({ id: "a3" }),
    ];
    const payload = workspace({
      actionNow: served,
      nodes: [node("a1", "act"), node("a2", "blocked"), node("a3", "act")],
    });

    const unfiltered = build(payload);
    const filtered = build(payload, { actionNow: [served[0]!] });

    expect(filtered.counts?.action).toBe(unfiltered.counts?.action);
    expect(filtered.counts?.needsres).toBe(unfiltered.counts?.needsres);
    // The TABLE narrows, which is what a search is for.
    expect(filtered.actionRows?.map((row) => row.id)).toEqual(["a1"]);
  });

  it("does not fall below zero when a lane array is capped under its own count", () => {
    const model = build(
      workspace({
        actionNow: [metaRec({ id: "a1" })],
        nodes: [node("a1", "blocked")],
        // A payload whose count exceeds its served array: the blocked row we
        // can see moves, and the rest of the count stays where the server put
        // it, because a row past the cap was drawn in neither lane.
        counts: { actionNow: 1 },
      }),
    );

    expect(model.counts?.action).toBe(0);
    expect(model.counts?.needsres).toBe(1);
  });
});

describe("a blocked row is drawn without an action", () => {
  it("uses the inspector's buyer verdict on the blocked row", () => {
    const recommendation = metaRec({
      id: "rec_blocked_cut",
      decisionLabel: "cut",
    });
    const model = buildMetaDecisionCenterExactViewModel({
      workspace: workspace({
        actionNow: [recommendation],
        nodes: [node(recommendation.id, "blocked")],
      }),
      account: null,
      now: Date.parse("2026-08-17T12:00:00.000Z"),
      defaultSelectionLane: "needsres",
    });

    expect(model.needsResolutionRows?.[0]?.decisionLabel).toBe(
      "Reduce spend",
    );
    expect(model.inspector?.decisionLabel).toBe(
      model.needsResolutionRows?.[0]?.decisionLabel,
    );
  });

  it("shows the specific commercial gap instead of its generic diagnostic consequence", () => {
    const recommendation = metaRec({
      id: "rec_commercial_gap",
      title: "Commercial target required",
      automationReadiness: {
        contractVersion: "meta-automation-readiness.v1",
        tier: "manual_review",
        autoExecuteEligible: false,
        operatorReviewRequired: true,
        decisionLabel: "diagnose",
        blockers: [
          "diagnostic_or_watch_state",
          "missing_commercial_anchor",
        ],
        missingEvidence: [],
        requiredEvidence: ["commercial_target"],
        reason: "A commercial target must be confirmed.",
      },
    });
    const row = build(
      workspace({
        actionNow: [recommendation],
        nodes: [node(recommendation.id, "blocked")],
      }),
    ).needsResolutionRows?.[0];

    expect(row).toMatchObject({
      blocker: "A valid performance target is required.",
      blockerCount: 2,
      blockerBuyerFacing: true,
      // A target ROAS alone anchors every action now, so the copy no longer
      // asks for a break-even the engine does not require (D091).
      resolution: "Confirm the ROAS target before acting.",
    });
    expect(JSON.stringify(row)).not.toContain(
      "Review the evidence; no change is currently authorized.",
    );
  });

  it("prioritizes decision evidence over an earlier executor blocker", () => {
    const recommendation = metaRec({
      id: "rec_b",
      title: "Held campaign",
      confidence: "low",
      confidenceReason: "automatic_campaign_context_review_only",
      automationReadiness: {
        contractVersion: "meta-automation-readiness.v1",
        tier: "manual_review",
        autoExecuteEligible: false,
        operatorReviewRequired: true,
        decisionLabel: "diagnose",
        blockers: [
          "missing_executor",
          "unsupported_action_class",
          "missing_live_preflight",
          "low_confidence",
          "missing_commercial_anchor",
        ],
        missingEvidence: ["commercial_target"],
        requiredEvidence: ["commercial_target"],
        reason: "Resolve source freshness before acting.",
      },
    });
    const model = build(
      workspace({
        actionNow: [recommendation],
        nodes: [node("rec_b", "blocked")],
      }),
    );

    const row = model.needsResolutionRows?.[0];
    expect(row?.id).toBe("rec_b");
    expect(row?.blocker).toBe("A valid performance target is required.");
    expect(row?.blockerCount).toBe(6);
    expect(row?.blockerBuyerFacing).toBe(true);
    expect(row?.resolution).toBe(
      "Confirm the ROAS target before acting.",
    );
    expect(JSON.stringify(row)).not.toMatch(/apply this change/i);
    expect(row?.staleDemotedReason).toBe(
      "Confidence is limited by campaign context",
    );
    expect(JSON.stringify(row)).not.toContain(
      "automatic_campaign_context_review_only",
    );
    expect(JSON.stringify(row)).not.toContain(
      "Resolve source freshness before acting.",
    );
    expect(JSON.stringify(row)).not.toContain(
      "Restore commercial target provenance before this can move.",
    );
    // `authority_blocker IS NOT NULL` implies `authorized_action IS NULL`, so
    // there is nothing here for a control to invoke.
    expect(Object.keys(row ?? {})).not.toContain("onPrimary");
    expect(Object.keys(row ?? {})).not.toContain("actionLabel");
  });

  it("keeps an executor-only next step conditional on human review", () => {
    const recommendation = metaRec({
      id: "rec_executor_only",
      title: "Manual campaign",
      automationReadiness: {
        contractVersion: "meta-automation-readiness.v1",
        tier: "manual_review",
        autoExecuteEligible: false,
        operatorReviewRequired: true,
        decisionLabel: "scale",
        blockers: ["missing_executor"],
        missingEvidence: [],
        requiredEvidence: [],
        reason: "No executor is enabled.",
      },
    });
    const row = build(
      workspace({
        actionNow: [recommendation],
        nodes: [node(recommendation.id, "blocked")],
      }),
    ).needsResolutionRows?.[0];

    expect(row).toMatchObject({
      blocker: "This action needs a manual Meta review.",
      blockerCount: 1,
      blockerBuyerFacing: true,
      resolution:
        "Review the evidence before making any manual change in Meta.",
    });
    expect(JSON.stringify(row)).not.toMatch(/apply this change/i);
    expect(Object.keys(row ?? {})).not.toContain("onPrimary");
    expect(Object.keys(row ?? {})).not.toContain("actionLabel");
  });
});
