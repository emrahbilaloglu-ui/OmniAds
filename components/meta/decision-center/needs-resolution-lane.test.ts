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
import { describe, expect, it } from "vitest";

import { metaRec } from "@/components/meta/redesign/test-fixtures";
import type {
  MetaDecisionsWorkspacePayload,
} from "@/components/meta/redesign/types";
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

  it("treats an unserved projection as unknown, not as zero blocked rows", () => {
    const model = build(
      workspace({ actionNow: [metaRec({ id: "rec_a" })] }),
    );

    expect(model.needsResolutionRows).toEqual([]);
    expect(model.counts?.needsres).toBe(0);
    // The lane says the difference out loud rather than drawing an empty list.
    expect(model.needsResolutionNotice).toContain(
      "No decision projection was served",
    );
    expect(model.needsResolutionNotice).toContain(
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
  it("carries the server's blocker and next step, and no primary callback", () => {
    const model = build(
      workspace({
        actionNow: [metaRec({ id: "rec_b", title: "Held campaign" })],
        nodes: [node("rec_b", "blocked")],
      }),
    );

    const row = model.needsResolutionRows?.[0];
    expect(row?.id).toBe("rec_b");
    expect(row?.blocker).toBeTruthy();
    expect(row?.resolution).toBe(
      "Restore commercial target provenance before this can move.",
    );
    // `authority_blocker IS NOT NULL` implies `authorized_action IS NULL`, so
    // there is nothing here for a control to invoke.
    expect(Object.keys(row ?? {})).not.toContain("onPrimary");
    expect(Object.keys(row ?? {})).not.toContain("actionLabel");
  });
});
