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
  decisionCenterHeaderFacts,
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

describe("the header KPI strip", () => {
  const money = (value: number | null | undefined, currency: string | null) =>
    typeof value === "number" ? `${currency === "USD" ? "$" : ""}${value.toFixed(0)}` : "—";

  const full = () =>
    decisionCenterHeaderFacts({
      pacing: { spendToday: 4120, avg7dSpend: 3887, conversionsToday: 138, avg7dConversions: 129 },
      roas: { selected: 4.26, d28: 4.26, target: 3.8 },
      roasHistory: [3.9, 4.1, 4.26],
      labelCoverage: { activeCampaigns: 22, labeledCampaigns: 18 },
      operatingMode: "standard",
      seasonalRegime: "high_season",
      trackingHealth: { status: "healthy", detail: "ok" },
      snapshotHealth: { status: "fresh", ageHours: 2 },
      engineVersion: "v3.2",
      lastSyncLabel: "12m ago",
      currency: "USD",
      windowLabel: "28D",
      formatMoney: money,
    });

  const byKey = (key: string) => full().find((fact) => fact.key === key)!;

  it("reports today's spend against the measured 7-day baseline", () => {
    expect(byKey("spend")).toMatchObject({
      value: "$4120",
      adjunct: "+6% vs 7d avg",
      note: "138 conversions · 7d avg 129",
    });
  });

  /**
   * The window heading and the number have to agree. `roas.selected` is the
   * server's figure for the window being shown; `d28` under a "7D" heading
   * would be a 28-day answer to a 7-day question.
   */
  it("reads ROAS for the selected window, and names the window it read", () => {
    const roas = decisionCenterHeaderFacts({
      roas: { selected: 5.4, d28: 4.26, target: 3.8 },
      windowLabel: "7D",
      formatMoney: money,
    }).find((fact) => fact.key === "roas")!;
    expect(roas.value).toBe("5.40");
    expect(roas.label).toBe("ROAS · 7D");
    expect(roas.adjunct).toBe("target 3.80");
  });

  it("states label coverage as the ratio the server counted", () => {
    expect(byKey("labels")).toMatchObject({ value: "18/22", adjunct: "82%", tone: "warn" });
  });

  it("carries the operating mode with its season and tracking chips", () => {
    const mode = byKey("mode");
    expect(mode.value).toBe("Standard");
    expect(mode.chips.map((chip) => chip.text)).toEqual(["High Season", "Tracking OK"]);
  });

  it("shows snapshot freshness and its age", () => {
    expect(byKey("snapshot").chips[0]).toMatchObject({ text: "fresh · 2h old", tone: "ok" });
  });

  /**
   * The strip is the first thing read on this surface. A missing measurement
   * printed as 0 -- $0 spent, 0.00 ROAS, 0/0 labelled -- is indistinguishable
   * from a real one, and every one of those zeros would read as an emergency.
   */
  describe("when the pulse did not measure something", () => {
    const empty = decisionCenterHeaderFacts({ formatMoney: money });
    const key = (name: string) => empty.find((fact) => fact.key === name)!;

    it("prints an em dash rather than a zero", () => {
      expect(key("spend").value).toBe("—");
      expect(key("roas").value).toBe("—");
      expect(key("labels").value).toBe("—");
      expect(key("mode").value).toBe("—");
    });

    it("says the measurement is absent instead of implying none happened", () => {
      expect(key("spend").note).toBe("conversions not measured");
      expect(key("labels").note).toBe("label coverage not measured");
    });

    it("does not claim a target that was never configured", () => {
      expect(key("roas").adjunct).toBe("no target set");
    });

    it("does not invent a trend line from a single point", () => {
      expect(key("roas").spark).toBeNull();
    });

    it("reports unknown snapshot freshness as unknown, not fresh", () => {
      expect(key("snapshot").chips[0]).toMatchObject({ text: "unknown · age unknown", tone: "warn" });
    });
  });

  it("suppresses a percentage when the baseline is zero rather than dividing by it", () => {
    const spend = decisionCenterHeaderFacts({
      pacing: { spendToday: 400, avg7dSpend: 0 },
      formatMoney: money,
    }).find((fact) => fact.key === "spend")!;
    expect(spend.adjunct).toBeNull();
  });
});
