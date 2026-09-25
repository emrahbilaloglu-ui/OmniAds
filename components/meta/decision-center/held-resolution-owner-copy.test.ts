import { describe, expect, it } from "vitest";

import {
  buildMetaDecisionCenterExactViewModel,
  buyerFacingCreativeResolution,
  heldCreativeVerdict,
} from "./meta-decision-center-exact-adapter";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type { MetaOsAdDecision } from "@/lib/meta/decisions-os-contract";

/*
  WHO HAS TO ACT is served, not inferred.

  `lib/meta/decision-semantics.ts` stamps every resolution with an `owner`. A
  `system` resolution (and an `integration` one in the `data` category) clears
  when the pipeline catches up, so its copy states what is outstanding and that
  nothing is required. Only an `operator` resolution — or an integration hold
  outside `data`, such as tracking — is phrased as a task. The lane, state,
  published label and held action are never touched: this is wording only.
*/

type Resolution = NonNullable<MetaOsAdDecision["resolution"]>;

const CHORES = [
  /Verify provider campaign configuration/,
  /Restore fresh, completed Meta source data/,
  /Refresh decision data/,
  /Complete the missing evidence/,
  /Restore the ad-level decision profile/,
];

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

const configGap = {
  decisionId: "decision_1",
  sourceSnapshotId: "snapshot_1",
  identityGrain: "ad",
  metrics: { currency: "USD" },
  configEvidence: { verified: false },
} as unknown as MetaCanonicalDecision;

function configProvenance(code: string) {
  return {
    availability: "available" as const,
    preAuthorityLabel: "cut",
    postAuthorityRawLabel: "cut",
    publishedLabel: "test_more",
    firstBlocker: { code, label: "Internal", explanation: "Internal" },
  } as unknown as MetaOsAdDecision["authorityProvenance"];
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

describe("held and blocked creative steps follow the served resolution owner", () => {
  it("states a system-owned config hold as a condition, never a chore", () => {
    const held = decision({
      blockers: [{ code: "config_source_authority", label: "Internal" }],
      authorityProvenance: configProvenance("config_source_authority"),
    });
    const verdict = heldCreativeVerdict(held, configGap);

    expect(verdict?.label).toBe("Pause signal · configuration unverified");
    expect(verdict?.nextStep).toContain(
      "Review the current setup and recent results in Meta before making a manual decision.",
    );
    expect(verdict?.nextStep).toContain("no automated change is available");
    for (const chore of CHORES) expect(verdict?.nextStep).not.toMatch(chore);
  });

  it("does not suggest a manual pause when native confirmation or campaign-role authority is also missing", () => {
    const held = decision({
      blockers: [{ code: "config_source_authority", label: "Internal" }],
      authorityProvenance: configProvenance("config_source_authority"),
    });
    const pending = {
      ...configGap,
      sourceDecision: { badges: ["pending_transition"] },
    } as MetaCanonicalDecision;
    const lowTrust = {
      ...configGap,
      classification: {
        lifecycleRole: { trustedForAction: false },
        blockers: [{ code: "campaign_context_low_confidence" }],
      },
    } as MetaCanonicalDecision;

    for (const [decisionRow, canonical] of [
      [held, pending],
      [held, lowTrust],
      [decision({ ...held, campaignRoleTrustedForAction: false }), configGap],
    ] as const) {
      const verdict = heldCreativeVerdict(decisionRow, canonical);
      expect(verdict?.label).not.toBe("Pause signal · configuration unverified");
      expect(verdict?.nextStep).not.toContain("before making a manual decision");
    }
  });

  it("states a system-owned D101 gap on a cut signal without asking the buyer to restore data", () => {
    const held = decision({
      rawLabel: "test_more",
      blockers: [{ code: "source_coverage_unverified", label: "Internal" }],
      authorityProvenance: configProvenance("source_freshness"),
    });
    const verdict = heldCreativeVerdict(held);

    expect(verdict?.label).toBe("Pause signal awaiting verification");
    expect(verdict?.nextStep).toContain("Fresh, completed Meta source data is still arriving.");
    expect(verdict?.nextStep).toContain(
      "No action is needed from you; the pause signal is re-checked on each decision run.",
    );
    for (const chore of CHORES) expect(verdict?.nextStep).not.toMatch(chore);
  });

  it("points a data-integration hold at the sync, not at the snapshot refresh control", () => {
    const blocked = decision({
      heldAction: null,
      heldResolution: null,
      publishedLabel: "diagnose",
      rawLabel: "diagnose",
      resolution: resolution("refresh_decision_data", "integration", "data"),
    });

    expect(buyerFacingCreativeResolution(blocked)).toBe(
      "Decision data for this ad is waiting for the next Meta sync. No action is needed from you; this ad is re-checked on each decision run.",
    );
  });

  it("keeps an operator-owned task imperative and states the pipeline condition beside it", () => {
    const held = decision({
      heldAction: "refresh",
      rawLabel: "refresh",
      publishedLabel: "keep",
      heldResolution: resolution("confirm_commercial_target", "operator", "commercial_truth"),
      authorityProvenance: configProvenance("profile_hard_action_ineligible"),
    });
    const verdict = heldCreativeVerdict(held, configGap);

    expect(verdict?.label).toBe("Recommendation awaiting review: Refresh creative");
    expect(verdict?.nextStep).toBe(
      "Confirm the commercial target before acting. " +
        "The campaign configuration for every day behind it is not confirmed yet. " +
        "Then review this Refresh creative recommendation again.",
    );
    expect(verdict?.nextStep).not.toContain("No action is needed from you");
  });

  it("keeps tracking and delivery tasks imperative: the buyer can act on them", () => {
    const tracking = decision({
      heldAction: null,
      heldResolution: null,
      publishedLabel: "diagnose",
      resolution: resolution("repair_tracking", "integration", "tracking"),
    });
    const delivery = decision({
      heldAction: null,
      heldResolution: null,
      publishedLabel: "diagnose",
      resolution: resolution("fix_delivery", "operator", "delivery"),
    });

    expect(buyerFacingCreativeResolution(tracking)).toBe(
      "Verify purchase tracking before acting.",
    );
    expect(buyerFacingCreativeResolution(delivery)).toBe(
      "Restore delivery, then review the ad again.",
    );
  });

  it("moves no row: lane, state, published label and action stay as served", () => {
    const rows = [
      decision({ id: "os_system", decisionId: "d_system", sourceSnapshotId: "s_system" }),
      decision({
        id: "os_operator",
        decisionId: "d_operator",
        sourceSnapshotId: "s_operator",
        heldAction: "refresh",
        rawLabel: "refresh",
        publishedLabel: "keep",
        heldResolution: resolution("confirm_commercial_target", "operator", "commercial_truth"),
      }),
    ];
    const model = buildMetaDecisionCenterExactViewModel({ workspace: workspaceWith(rows) });
    const byId = new Map(model.creativeDecisions?.map((row) => [row.id, row]));
    const system = byId.get("os_system");
    const operator = byId.get("os_operator");

    expect(system?.stateLabel).toBe("Blocked");
    expect(system?.decisionLabel).toBe("Continue testing");
    expect(system?.heldVerdictLabel).toBe("Recommendation on hold: Pause ad");
    // Desktop and mobile read the same sentence from the one producer.
    expect(system?.heldVerdictNextStep).toBe(system?.note);
    expect(system?.note).toContain("No action is needed from you");

    expect(operator?.stateLabel).toBe("Blocked");
    expect(operator?.decisionLabel).toBe("Keep monitoring");
    expect(operator?.note).toContain("Confirm the commercial target before acting.");
    expect(operator?.note).not.toContain("No action is needed from you");
  });
});
