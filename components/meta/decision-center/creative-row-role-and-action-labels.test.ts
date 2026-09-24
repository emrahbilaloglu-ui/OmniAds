import { describe, expect, it } from "vitest";

import { metaRec } from "@/components/meta/redesign/test-fixtures";
import {
  buildMetaDecisionCenterExactViewModel,
  buyerFacingCreativeActionLabel,
  buyerHeldVerdictLabel,
} from "./meta-decision-center-exact-adapter";
import type { MetaOsAdDecision } from "@/lib/meta/decisions-os-contract";

/*
  WHAT A CREATIVE ROW MAY CLAIM ABOUT ITS CAMPAIGN ROLE, AND WHAT ITS CUT MEANS.

  1. The role chip prints Main/Test/Mixed only when the server marked the role
     trusted (`campaignRoleTrustedForAction`); an automatically inferred role
     says so, and an unresolved one says it is unresolved. The chip reads that
     one served field and moves no lane, state or action.
  2. An Ad-level Cut pauses the ad. Its buyer word is "Pause ad", not the budget
     phrase "Reduce spend", which stays on campaign and ad-set rows.

  Fixture helpers are copied from held-resolution-owner-copy.test.ts: importing
  one test file into another registers its suites twice.
*/

type Resolution = NonNullable<MetaOsAdDecision["resolution"]>;

function resolution(
  code: string,
  owner: Resolution["owner"],
  category: string,
): Resolution {
  return { code, owner, category, label: "Internal label", nextStep: "Internal producer copy" };
}

function decision(overrides: Partial<MetaOsAdDecision> = {}): MetaOsAdDecision {
  return {
    id: "os_ad_1",
    decisionId: "decision_1",
    sourceSnapshotId: "snapshot_1",
    episodeId: "episode_1",
    providerAccountId: "act_1",
    adId: "ad_1",
    adName: "Held Ad",
    campaignId: "cmp_1",
    campaignName: "Campaign",
    adsetId: "set_1",
    adsetName: "Ad set",
    creativeId: null,
    creativeName: null,
    thumbnailUrl: null,
    lifecycleRole: "main",
    campaignRoleSource: "automatic",
    campaignRoleConfidence: "high",
    campaignRoleTrustedForAction: true,
    action: {
      code: "complete_hard_action_evidence",
      label: "Complete Hard-Action Evidence",
      intent: "review",
      targetLevel: "ad",
      providerMutation: null,
      scopeNote: "",
    },
    lane: "blocked",
    priority: { rank: 1, score: 0.5, reason: "fixture" },
    assessment: "Internal assessment",
    confidence: "medium",
    confidenceScore: 0.6,
    riskTier: null,
    confirmationCeremony: "highest",
    whyNow: "[internal producer prose]",
    blockers: [],
    resolution: null,
    heldAction: "cut",
    heldResolution: resolution("complete_hard_action_evidence", "system", "system"),
    adPerformanceAvailability: "observed",
    metrics: {
      spend: 3332.16,
      purchases: 7,
      roas: 0.47,
      cpa: null,
      ctr: null,
      frequency: null,
      effectiveTargetRoas: 2.2,
      ratioToTarget: 0.21,
      currency: "USD",
      attribution: "meta_attributed",
      grain: "ad",
    },
    rawLabel: "cut",
    publishedLabel: "test_more",
    engineVersion: "v3-ad-fixture",
    snapshotAsOf: "2026-09-24",
    sourceGrain: "ad",
    decisionAvailability: "available",
    ...overrides,
  } as unknown as MetaOsAdDecision;
}

/** The served envelope around the creative queue, as the route returns it. */
function workspaceWith(rows: MetaOsAdDecision[]) {
  const count = (lane: string) => rows.filter((row) => row.lane === lane).length;
  return {
    businessId: "biz_1",
    window: "28d",
    startDate: "2026-08-28",
    endDate: "2026-09-24",
    pulse: {
      businessId: "biz_1",
      window: "28d",
      startDate: "2026-08-28",
      endDate: "2026-09-24",
      pacing: { mtdSpend: 0, mtdTarget: 0, dayPace: 0 },
      roas: { selected: Number.NaN, d7: Number.NaN, d14: Number.NaN, d28: Number.NaN, target: null, median: null, target_source: "none" },
      spend: { current: 0, prev: 0 },
      revenue: { current: 0, prev: 0 },
      cpa: { current: null, prev: null },
      matureCampaigns: 0,
      learningCampaigns: 0,
      operatingMode: "",
      seasonalRegime: "",
      engineLastRun: null,
      engineVersion: "fixture",
      trackingHealth: { status: "unknown", detail: "" },
      lastSyncAt: null,
      currency: "USD",
    },
    lanes: {
      businessId: "biz_1",
      startDate: "2026-08-28",
      endDate: "2026-09-24",
      sourceModel: "snapshot_persistent",
      snapshotDate: "2026-09-24",
      actionNow: [],
      watching: [],
      healthy: [],
      nonSales: [],
      archive: [],
      deferredIds: [],
      watchingSegments: [],
      counts: { actionNow: 0, watching: 0, healthy: 0, nonSales: 0, archive: 0 },
    },
    queue: {
      groups: [],
      actionStates: { executablePause: 0, executableBid: 0, executableResume: 0, launchpadRoutes: 0, reviewOnly: 0, missingActionKind: 0 },
    },
    system: {
      trackingBlocked: false,
      dataReadiness: null,
      snapshotHealth: null,
      laneSnapshotDate: "2026-09-24",
      laneSnapshotCreatedAt: "2026-09-24T09:00:00.000Z",
      engineVersion: "fixture",
      currency: "USD",
      killSwitchEngaged: false,
      killSwitchReason: null,
      pipelineHealth: null,
    },
    viewer: null,
    banners: [],
    digest: {
      snapshotDate: "2026-09-24",
      unavailableReason: null,
      labelFlips: { count: 0, publishedCount: 0, items: [] },
      actions: { verifiedCount: 0, silentFailureCount: 0, items: [] },
      anomalies: { openedCount: 0, items: [] },
      deferrals: { dueCount: 0, items: [] },
    },
    decisionReadModel: {
      scope: { businessId: "biz_1", providerAccountId: "act_1", decisionMode: "current", metricsRangeAffectsDecisionSnapshot: false },
      source: { snapshotAsOf: "2026-09-24", computedAt: "2026-09-24T07:00:00.000Z", engineVersion: "fixture" },
      queue: {
        adCandidates: { items: [] },
        sections: {},
        inactiveAssets: { preCapCount: 0, inactiveCount: 0, unknownCount: 0, items: [] },
      },
    },
    os: {
      contractVersion: "meta-os-decisions.presentation.v5",
      generatedAt: "2026-09-24T09:00:00.000Z",
      source: { snapshotAsOf: "2026-09-24", engineVersion: "fixture", structureSource: "meta_recommendations", adsSource: "native_ad_decision", health: "healthy", fallbackReason: null },
      structure: { groups: [], actCount: 0, blockedCount: 0, monitorCount: 0, suppressedAlternativeCount: 0 },
      ads: {
        items: rows,
        actCount: count("act"),
        blockedCount: count("blocked"),
        monitorCount: count("monitor"),
        statePreCapCounts: { act: count("act"), blocked: count("blocked"), monitor: count("monitor") },
        eligiblePreCapCount: rows.length,
        omittedWithoutVerifiedAdId: 0,
        omittedAmbiguousIdentity: 0,
        omittedNotApplicable: 0,
        sourcePreCapCount: rows.length,
      },
      limitations: [],
    },
  } as never;
}


function row(
  model: ReturnType<typeof buildMetaDecisionCenterExactViewModel>,
  id: string,
) {
  const found = model.creativeDecisions?.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing row ${id}`);
  return found;
}

function monitorRow(id: string, overrides: Partial<MetaOsAdDecision> = {}) {
  return decision({
    id,
    decisionId: `decision_${id}`,
    heldAction: null,
    heldResolution: null,
    lane: "monitor",
    rawLabel: "test_more",
    publishedLabel: "test_more",
    action: {
      code: "continue_test",
      label: "Continue Test",
      intent: "none",
      targetLevel: "ad",
      providerMutation: null,
      scopeNote: "",
    },
    ...overrides,
  });
}

describe("the creative role chip shows a campaign role only as the server trusts it", () => {
  const rows = [
    monitorRow("trusted_main", { lifecycleRole: "main", campaignRoleTrustedForAction: true }),
    monitorRow("inferred_main", { lifecycleRole: "main", campaignRoleTrustedForAction: false }),
    monitorRow("inferred_test", { lifecycleRole: "test", campaignRoleConfidence: "low", campaignRoleTrustedForAction: false }),
    monitorRow("unresolved", { lifecycleRole: "role_unresolved", campaignRoleConfidence: "unknown", campaignRoleTrustedForAction: false }),
    monitorRow("legacy_label_needed", { lifecycleRole: "label_needed", campaignRoleTrustedForAction: false }),
    monitorRow("unknown", { lifecycleRole: "unknown", campaignRoleTrustedForAction: false }),
  ];
  const model = buildMetaDecisionCenterExactViewModel({ workspace: workspaceWith(rows) });

  it("prints Main only for a trusted role", () => {
    expect(row(model, "trusted_main").chips?.[0]).toBe("Main");
  });

  it("labels an inferred role as inferred rather than settled", () => {
    expect(row(model, "inferred_main").chips?.[0]).toBe("Main (inferred)");
    expect(row(model, "inferred_test").chips?.[0]).toBe("Test (inferred)");
  });

  it("labels an unresolved role as unresolved, and never asks for a label", () => {
    for (const id of ["unresolved", "legacy_label_needed", "unknown"]) {
      expect(row(model, id).chips?.[0]).toBe("Role unresolved");
    }
    expect(JSON.stringify(model.creativeDecisions)).not.toMatch(/Label Needed|Role_unresolved|Role Unresolved/);
  });

  it("changes only the chip: lane, state and action stay as served", () => {
    const trusted = row(model, "trusted_main");
    const inferred = row(model, "inferred_main");
    expect(inferred.stateLabel).toBe(trusted.stateLabel);
    expect(inferred.decisionLabel).toBe(trusted.decisionLabel);
    expect(inferred.actionLabel).toBe(trusted.actionLabel);
    expect(inferred.chips?.slice(1)).toEqual(trusted.chips?.slice(1));
  });
});

describe("an Ad-level Cut is named for what it does", () => {
  it("names an Ad-level Cut as pausing the ad, held or ready", () => {
    expect(buyerHeldVerdictLabel("cut")).toBe("Pause ad");
    const held = decision({ id: "held_cut", decisionId: "decision_held_cut" });
    const ready = decision({
      id: "ready_cut",
      decisionId: "decision_ready_cut",
      lane: "act",
      heldAction: null,
      heldResolution: null,
      rawLabel: "cut",
      publishedLabel: "cut",
      action: {
        code: "cut",
        label: "Cut",
        intent: "execute",
        targetLevel: "ad",
        providerMutation: "pause",
        scopeNote: "Runs a live preflight, then pauses this exact ad only",
      },
    });
    const model = buildMetaDecisionCenterExactViewModel({ workspace: workspaceWith([held, ready]) });
    expect(row(model, "held_cut").heldVerdictLabel).toBe("Recommendation on hold: Pause ad");
    expect(row(model, "ready_cut").decisionLabel).toBe("Pause ad");
    expect(buyerFacingCreativeActionLabel(ready)).toBe("Review pause");
    expect(JSON.stringify(model.creativeDecisions)).not.toMatch(/Reduce spend|spend reduction/i);
  });

  it("keeps the budget wording on campaign and ad-set rows, which do own spend", () => {
    const workspace = workspaceWith([]) as unknown as {
      lanes: { actionNow: unknown[]; counts: { actionNow: number } };
    };
    workspace.lanes.actionNow = [
      metaRec({ id: "campaign_cut", decisionLabel: "cut", level: "campaign" }),
    ];
    workspace.lanes.counts.actionNow = 1;
    const model = buildMetaDecisionCenterExactViewModel({ workspace: workspace as never });
    const structureLabels = JSON.stringify([
      ...(model.actionRows ?? []),
      ...(model.needsResolutionRows ?? []),
      ...(model.watchingRows ?? []),
    ]);
    expect(structureLabels).toContain("Reduce spend");
    expect(structureLabels).not.toContain("Pause ad");
  });
});
