/**
 * The Decision Center body must present the server's verdict, never its own.
 *
 * `docs/meta-decision-center/INVARIANTS.md`: "UI must render backend-provided
 * recommendations; it must not compute buyer actions, decision labels, label
 * transforms, or automation readiness." These pin that boundary at the one
 * place the body could cross it.
 */
import { describe, expect, it } from "vitest";

import {
  decisionCenterHasCommand,
  decisionCenterItems,
  decisionCenterMoneyAtStake,
  decisionCenterQueueCounts,
  type DecisionCenterItem,
} from "@/components/meta/decision-center/decision-center-contract";
import type { MetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-contract";

function node(over: Record<string, unknown> = {}) {
  return {
    id: "n1",
    sourceRecommendationId: null,
    level: "campaign",
    providerEntityId: "123",
    campaignId: "c1",
    campaignName: "Prospecting",
    name: "Prospecting — Broad US",
    budgetOwner: "campaign",
    budgetMode: "campaign_budget",
    controlOwner: "campaign",
    status: "ACTIVE",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    action: {
      code: "scale_budget",
      label: "Scale budget +20%",
      intent: "launchpad",
      targetLevel: "campaign",
      providerMutation: null,
      scopeNote: "Routed Launchpad write with confirmation",
    },
    lane: "act",
    priority: "high",
    urgency: "now",
    confidence: "high",
    assessment: "ROAS above target on stable spend",
    whyNow: "12 consecutive days above target",
    expectedImpact: "$8.6k upside/mo",
    evidence: [{ label: "ROAS", value: "5.12", tone: "positive" }],
    metrics: {
      spend: 1240,
      purchases: 138,
      roas: 5.12,
      cpa: null,
      ctr: null,
      frequency: null,
      effectiveTargetRoas: 3.8,
      ratioToTarget: 1.35,
      currency: "USD",
      attribution: "meta_attributed",
      grain: "campaign_or_adset",
    },
    suppressedAlternativeCount: 0,
    ...over,
  };
}

function presentation(over: Record<string, unknown> = {}): MetaOsDecisionsPresentation {
  return {
    contractVersion: "meta-os-decisions-presentation.v2",
    generatedAt: "2026-08-16T00:00:00.000Z",
    source: {
      snapshotAsOf: "2026-08-14",
      engineVersion: "v3.2",
      structureSource: "meta_recommendations",
      adsSource: "native_ad_decision",
      health: "healthy",
      fallbackReason: null,
    },
    structure: {
      groups: [{ id: "g1", campaign: node(), adsets: [node({ id: "n2", level: "adset", lane: "monitor" })], highestPriority: "high", highestUrgency: "now", urgentAdsetCount: 1 }],
      actCount: 4,
      blockedCount: 2,
      monitorCount: 7,
      suppressedAlternativeCount: 0,
    },
    ads: {
      items: [],
      actCount: 3,
      blockedCount: 1,
      monitorCount: 5,
      statePreCapCounts: { act: 3, blocked: 1, monitor: 5 },
    },
    ...over,
  } as unknown as MetaOsDecisionsPresentation;
}

describe("the Decision Center body reads the server, never decides", () => {
  it("takes the action label and scope straight from the server verdict", () => {
    const [campaign] = decisionCenterItems(presentation(), "structure");
    expect(campaign.actionLabel).toBe("Scale budget +20%");
    expect(campaign.actionCode).toBe("scale_budget");
    expect(campaign.scopeNote).toBe("Routed Launchpad write with confirmation");
    // Confidence is the server's word, not a score the body re-bucketed.
    expect(campaign.confidence).toBe("high");
  });

  it("reports lane counts from the server, not by recounting the rendered cards", () => {
    // Only two structure nodes are rendered, but the server says 4/7/2 — the
    // card list is a top-N and must never restate the queue size.
    const items = decisionCenterItems(presentation(), "structure");
    expect(items).toHaveLength(2);
    expect(decisionCenterQueueCounts(presentation(), "structure")).toEqual({
      act: 4,
      monitor: 7,
      blocked: 2,
    });
    expect(decisionCenterQueueCounts(presentation(), "ads")).toEqual({
      act: 3,
      monitor: 5,
      blocked: 1,
    });
  });

  it("keeps campaign order and nests its ad sets beneath it", () => {
    const items = decisionCenterItems(presentation(), "structure");
    expect(items.map((i) => i.levelLabel)).toEqual(["Campaign", "Ad set"]);
  });

  describe("money at stake", () => {
    const items: DecisionCenterItem[] = [
      { ...decisionCenterItems(presentation(), "structure")[0]!, spend: 1240, lane: "act" },
      { ...decisionCenterItems(presentation(), "structure")[0]!, id: "b", spend: 680, lane: "act" },
      { ...decisionCenterItems(presentation(), "structure")[0]!, id: "c", spend: null, lane: "act" },
      { ...decisionCenterItems(presentation(), "structure")[0]!, id: "d", spend: 999, lane: "monitor" },
    ];

    it("sums only the requested lane", () => {
      expect(decisionCenterMoneyAtStake(items, "act").total).toBe(1920);
    });

    /**
     * A missing measurement is not zero. Counting it as $0 would quietly
     * understate the money an operator is being asked to act on, which is the
     * one number on the card they cannot check by eye.
     */
    it("counts unmeasured spend separately instead of treating it as zero", () => {
      const money = decisionCenterMoneyAtStake(items, "act");
      expect(money.measured).toBe(2);
      expect(money.unmeasured).toBe(1);
      expect(money.currency).toBe("USD");
    });
  });

  describe("command availability", () => {
    const base = decisionCenterItems(presentation(), "structure")[0]!;

    it("offers a command only where the server routed one", () => {
      expect(decisionCenterHasCommand({ ...base, lane: "act", actionIntent: "launchpad" })).toBe(true);
      expect(decisionCenterHasCommand({ ...base, lane: "act", actionIntent: "execute" })).toBe(true);
    });

    it("withholds it when the server withheld it, or when the lane is not act", () => {
      expect(decisionCenterHasCommand({ ...base, lane: "act", actionIntent: "none" })).toBe(false);
      expect(decisionCenterHasCommand({ ...base, lane: "act", actionIntent: "review" })).toBe(false);
      expect(decisionCenterHasCommand({ ...base, lane: "blocked", actionIntent: "execute" })).toBe(false);
      expect(decisionCenterHasCommand({ ...base, lane: "monitor", actionIntent: "execute" })).toBe(false);
    });
  });
});
