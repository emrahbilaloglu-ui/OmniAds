import { describe, expect, it } from "vitest";
import type {
  MetaCanonicalDecision,
  MetaDecisionAuthorityBlocker,
  MetaDecisionBuyerAction,
  MetaDecisionsWorkspaceReadModel,
} from "@/lib/meta/decisions-workspace-contract";
import { META_DECISION_SOURCE_DEGRADED_REASON } from "@/lib/meta/decisions-workspace-contract";
import { projectMetaDecisionSemantics } from "@/lib/meta/decision-semantics";
import {
  adOsLaneForCanonicalDecision,
  buildMetaOsDecisionsPresentation,
} from "@/lib/meta/decisions-os-presentation";
import { applyMetaExecutionGovernanceToReadModel } from "@/lib/meta/decisions-workspace-read-model";
import { readMetaPreCapAdCandidates } from "@/lib/meta/decisions-pre-cap-ad-candidates";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

/*
  The creative lane tabs count the SAME lane each row is drawn in.

  The reader keeps a process-local, lane-relevant projection of every pre-cap
  candidate; the presentation runs `adOsLaneForCanonicalDecision` — the exact
  function `adDecision` uses — over it. An uncounted source is null, never 0.

  The builders below are copied verbatim from decisions-os-presentation.test.ts
  so this file does not edit that shared fixture file.
*/

// ---- fixtures (verbatim copies) -------------------------------------------
function canonicalDecision(input: {
  id: string;
  adId: string | null;
  buyerAction: MetaDecisionBuyerAction;
  role?: MetaCanonicalDecision["classification"]["lifecycleRole"]["value"];
  candidateAdCount?: number;
}): MetaCanonicalDecision {
  const candidateAdCount = input.candidateAdCount ?? (input.adId ? 1 : 0);
  return {
    decisionId: input.id,
    episodeId: `${input.id}:episode`,
    episodeStartedAt: "2026-07-10",
    providerAccountId: "act_1",
    identityGrain: "creative",
    sourceSnapshotId: `${input.id}:snapshot`,
    sourceDecision: {
      label:
        input.buyerAction === "diagnose_data" ? "diagnose" : input.buyerAction,
      preAuthorityLabel:
        input.buyerAction === "diagnose_data" ? "diagnose" : input.buyerAction,
      authorityBlocker: null,
      rawLabel: input.buyerAction,
      reason: "Persisted server decision.",
      confidence: 0.8,
      confidenceBand: "high",
      truthSource: "commercial_truth",
      engineVersion: "v3-test",
      snapshotAsOf: "2026-07-10",
      computedAt: "2026-07-10T04:00:00.000Z",
      badges: [],
      provenance: {
        source: "test",
        field: "decision",
        recordId: input.id,
        asOf: "2026-07-10",
        version: "v3-test",
      },
    },
    parentChain: {
      account: { id: "act_1", name: "Account" },
      campaign: { id: "cmp_1", name: "Main campaign" },
      adset: { id: "set_1", name: "Broad" },
      ad: input.adId ? { id: input.adId, name: `Ad ${input.adId}` } : null,
      creative: { id: `creative:${input.id}`, name: `Creative ${input.id}` },
      provenance: {
        source: "test",
        field: "identity",
        recordId: input.id,
        asOf: "2026-07-10",
        version: null,
      },
    },
    identityResolution: {
      basis:
        candidateAdCount === 1
          ? "single_ad_creative_equivalent"
          : candidateAdCount > 1
            ? "creative_ambiguous"
            : "unresolved",
      candidateAdCount,
      metricsEquivalent: candidateAdCount === 1,
      adActionEligible: candidateAdCount === 1,
    },
    media: {
      state: "missing",
      missingMedia: true,
      thumbnail: { state: "missing", url: null },
      provenance: {
        source: "test",
        field: "media",
        recordId: input.id,
        asOf: "2026-07-10",
        version: null,
      },
    },
    classification: {
      overlayVersion: "meta-decisions-classification-overlay.v5",
      queueSection: "creative_rotation",
      lifecycleRole: {
        value: input.role ?? "main",
        confidence: "high",
        trustedForAction: true,
        blockerCode: null,
        provenance: {
          source: "test",
          field: "role",
          recordId: input.id,
          asOf: "2026-07-10",
          version: null,
        },
      },
      assessment: {
        value:
          input.buyerAction === "cut"
            ? "below_target"
            : input.buyerAction === "test_more"
              ? "learning"
              : input.buyerAction === "diagnose_data"
                ? "decision_blocked"
                : "proven_winner",
        blockerCode: null,
        provenance: {
          source: "test",
          field: "assessment",
          recordId: input.id,
          asOf: "2026-07-10",
          version: null,
        },
      },
      decisionState:
        input.buyerAction === "diagnose_data"
          ? "blocked"
          : input.buyerAction === "cut" || input.buyerAction === "refresh"
            ? "act"
            : input.buyerAction === "scale" &&
                (input.role === "test" || input.role === "mixed")
              ? "act"
              : "monitor",
      heldAction: null,
      legacyBuyerAction: input.buyerAction,
      buyerAction:
        input.buyerAction === "diagnose_data" ? null : input.buyerAction,
      buyerLabel: input.buyerAction,
      executionAction: input.buyerAction === "scale" ? "scale_budget" : null,
      resolution:
        input.buyerAction === "diagnose_data"
          ? {
              code: "resolve_evidence_gap",
              category: "system",
              owner: "system",
              label: "Resolve Evidence Gap",
              nextStep: "Complete missing evidence.",
            }
          : null,
      blockers: [],
      provenance: {
        source: "test",
        field: "classification",
        recordId: input.id,
        asOf: "2026-07-10",
        version: null,
      },
    },
    riskTier: null,
    confirmationCeremony: "highest",
    riskTierProvenance: {
      status: "proposed",
      reason: "risk_tier_producer_not_persisted",
    },
    promotionBasis: {
      status: "proposed",
      value: null,
      reason: "promotion_basis_not_persisted",
    },
    metrics: {
      spend: 100,
      purchases: 4,
      roas: 2.4,
      recent7dRoas: 2.2,
      effectiveTargetRoas: 1.8,
      ratioToTarget: 1.33,
      currency: "EUR",
      attribution: "meta_attributed",
      provenance: {
        source: "test",
        field: "metrics",
        recordId: input.id,
        asOf: "2026-07-10",
        version: null,
      },
    },
    exposure: null,
    exposureUnavailableReason: null,
    history: {
      events: { status: "available", reason: null, preCapCount: 0, items: [] },
      outcomes: { status: "available", reason: null, items: [] },
      responses: {
        status: "unavailable",
        reason: "legacy_response_journal_not_keyed_by_decision_episode",
      },
      providerWrites: {
        status: "unavailable",
        reason: "provider_write_journal_not_keyed_by_decision_episode",
      },
    },
  };
}

function readModel(
  items: MetaCanonicalDecision[],
): MetaDecisionsWorkspaceReadModel {
  const emptySection = (
    key: "integrity_fires" | "money_moves" | "creative_rotation",
  ) => ({
    key,
    label: key,
    topN: 5,
    preCapCount: key === "creative_rotation" ? items.length : 0,
    selectedCount: key === "creative_rotation" ? items.length : 0,
    rankablePreCapCount: key === "creative_rotation" ? items.length : 0,
    unrankablePreCapCount: 0,
    items: key === "creative_rotation" ? items : [],
    exposureDigest: {
      basis: "pre_cap" as const,
      byCurrency: [],
      unavailableCount: 0,
      crossCurrencyTotal: null,
    },
    suppressionReceipt: {
      receiptId: `receipt:${key}`,
      selectionVersion: "meta-decisions-section-selection.v1" as const,
      topN: 5,
      preCapCount: key === "creative_rotation" ? items.length : 0,
      selectedCount: key === "creative_rotation" ? items.length : 0,
      suppressedCount: 0,
      reasons: [],
    },
  });
  return {
    contractVersion: "meta-decisions-workspace.read.v4",
    status: "available",
    generatedAt: "2026-07-10T04:00:00.000Z",
    scope: {
      businessId: "biz_1",
      providerAccountId: "act_1",
      decisionMode: "current",
      metricsRangeAffectsDecisionSnapshot: false,
    },
    unavailable: null,
    source: {
      status: "available",
      authority: "legacy_creative",
      table: "engine_v3_decision_snapshots_daily",
      snapshotAsOf: "2026-07-10",
      computedAt: "2026-07-10T04:00:00.000Z",
      engineVersion: "v3-test",
      fallbackReason: "native_generation_unavailable",
      generation: null,
    },
    queue: {
      deduplicationGrain: "creative",
      sourcePreCapCount: items.length,
      queuedPreCapCount: items.length,
      sections: {
        integrity_fires: emptySection("integrity_fires"),
        money_moves: emptySection("money_moves"),
        creative_rotation: emptySection("creative_rotation"),
      },
      omittedFromQueue: { count: 0, reasons: [] },
    },
    capabilities: {
      providerAccountScope: { status: "available", reason: null },
      stableDecisionIdentity: { status: "available", reason: null },
      stableEpisodeIdentity: { status: "available", reason: null },
      classificationOverlay: { status: "available", reason: null },
      riskTierProducer: { status: "proposed", reason: "test" },
      promotionBasisProducer: { status: "proposed", reason: "test" },
      responseAttribution: { status: "unavailable", reason: "test" },
      providerWriteLinkage: { status: "unavailable", reason: "test" },
    },
  };
}

function heldCanonicalDecision(input: {
  id: string;
  adId: string;
  heldAction: "scale" | "cut" | "refresh";
  publishedLabel: string;
  authorityBlocker: MetaDecisionAuthorityBlocker;
  legacyBuyerAction: MetaDecisionBuyerAction;
  predicateBlockers?: ReadonlyArray<{
    predicate: string;
    observed: string | number | null;
    threshold: string | number | null;
  }>;
}): MetaCanonicalDecision {
  const decision = canonicalDecision({
    id: input.id,
    adId: input.adId,
    buyerAction: input.legacyBuyerAction,
  });
  const semantics = projectMetaDecisionSemantics({
    legacyBuyerAction: input.legacyBuyerAction,
    sourceLabel: input.publishedLabel,
    lifecycleRole: "main",
    badgeCodes: [],
    blockerCodes: [],
    heldAction: input.heldAction,
    authorityBlocker: input.authorityBlocker,
    predicateBlockers: input.predicateBlockers ?? [],
  });
  decision.identityGrain = "ad";
  decision.sourceDecision.label = input.publishedLabel;
  decision.sourceDecision.rawLabel = input.publishedLabel;
  decision.sourceDecision.preAuthorityLabel = input.heldAction;
  decision.sourceDecision.authorityBlocker = input.authorityBlocker;
  decision.classification.decisionState = semantics.decisionState;
  decision.classification.heldAction = semantics.heldAction;
  decision.classification.legacyBuyerAction = semantics.legacyBuyerAction;
  decision.classification.buyerAction = semantics.buyerAction;
  decision.classification.resolution = semantics.resolution;
  decision.classification.executionAction = null;
  // A fully authorized native exact identity, so nothing about the ad itself
  // is what withholds the action: only the held verdict is.
  decision.sourceAuthority = {
    status: "native_exact",
    actionEligible: true,
    reviewOnlyReason: null,
    snapshotId: decision.sourceSnapshotId,
    evaluationId: "10000000-0000-4000-8000-000000000501",
    inputHash: "a".repeat(64),
    decisionHash: "b".repeat(64),
    providerAccountRefId: "30000000-0000-4000-8000-000000000001",
    engineVersion: "v3-ad-test",
    realAdId: input.adId,
    authorizedAction: input.heldAction === "cut" ? "cut" : null,
    executionReadiness: "live_preflight_required",
    jobRunId: "20000000-0000-4000-8000-000000000001",
  };
  return decision;
}

function nativeReadModel(
  decisions: MetaCanonicalDecision[],
): MetaDecisionsWorkspaceReadModel {
  const model = readModel(decisions);
  model.source.authority = "native_ad";
  model.source.table = "engine_v3_ad_decision_snapshots_daily";
  model.source.fallbackReason = null;
  return model;
}

// ---- the pre-cap population, as the reader attaches it ---------------------

const PRE_CAP = Symbol.for("adsecute.meta.decisions.pre-cap-ad-candidates");

function withPreCap(
  model: MetaDecisionsWorkspaceReadModel,
  candidates: MetaCanonicalDecision[],
): MetaDecisionsWorkspaceReadModel {
  Object.defineProperty(model, PRE_CAP, {
    value: candidates,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return model;
}

function candidateEnvelope(
  model: MetaDecisionsWorkspaceReadModel,
  selected: MetaCanonicalDecision[],
  eligiblePreCapCount: number,
) {
  model.queue.adCandidates = {
    selectionVersion: "meta-decisions-ad-candidate-selection.v1",
    limit: 60,
    preCapCount: eligiblePreCapCount,
    eligiblePreCapCount,
    selectedCount: selected.length,
    // The reader's OLD decisionState buckets, deliberately wrong for the
    // rows below, to prove the tabs no longer read them.
    stateCounts: {
      act: { preCapCount: 99, selectedCount: 0 },
      blocked: { preCapCount: 99, selectedCount: 0 },
      monitor: { preCapCount: 99, selectedCount: 0 },
    },
    omittedAmbiguousIdentity: 0,
    omittedWithoutVerifiedAdId: 0,
    omittedNotApplicable: 0,
    items: selected,
  } as never;
  return model;
}

function nativeAd(decision: MetaCanonicalDecision): MetaCanonicalDecision {
  decision.identityGrain = "ad";
  return decision;
}

describe("creative lane counts follow the served lane, before the cap", () => {
  const roleHeldCut = heldCanonicalDecision({
    id: "role-held-cut",
    adId: "120000000000000701",
    heldAction: "cut",
    publishedLabel: "test_more",
    authorityBlocker: "campaign_context",
    legacyBuyerAction: "test_more",
  });
  const systemHeldCut = heldCanonicalDecision({
    id: "config-held-cut",
    adId: "120000000000000702",
    heldAction: "cut",
    publishedLabel: "test_more",
    authorityBlocker: "config_source_authority",
    legacyBuyerAction: "test_more",
  });
  const targetIneligibleCut = nativeAd(
    canonicalDecision({ id: "target-cut", adId: "120000000000000703", buyerAction: "cut" }),
  );
  const refresh = nativeAd(
    canonicalDecision({ id: "refresh", adId: "120000000000000704", buyerAction: "refresh" }),
  );
  const testing = nativeAd(
    canonicalDecision({ id: "testing", adId: "120000000000000705", buyerAction: "test_more" }),
  );
  // Past the response cap: never served, still decisions.
  const cappedOut = Array.from({ length: 5 }, (_, index) =>
    heldCanonicalDecision({
      id: `capped-held-${index}`,
      adId: `12000000000000080${index}`,
      heldAction: "scale",
      publishedLabel: "keep",
      authorityBlocker: "profile_hard_action_ineligible",
      legacyBuyerAction: "test_more",
    }),
  );
  const population = [roleHeldCut, systemHeldCut, targetIneligibleCut, refresh, testing, ...cappedOut];
  const served = population.slice(0, 5);
  const eligibility = { scale: true, cut: false, refresh: true };

  function build(sourceDegraded = false) {
    const model = candidateEnvelope(nativeReadModel(served), served, population.length);
    if (sourceDegraded) {
      model.source.degraded = {
        reason: META_DECISION_SOURCE_DEGRADED_REASON,
        servedGeneration: { jobRunId: "job-retained", asOfDate: "2026-09-22" },
        latestTerminalRun: { jobRunId: "job-failed", status: "failed", asOfDate: "2026-09-24" },
      } as never;
    }
    withPreCap(model, population);
    return buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: model,
      currency: "EUR",
      targetHardActionEligibility: eligibility,
    });
  }

  it("counts a D097 role-held Cut in Act, where it is drawn, and a target-ineligible Cut in Blocked", () => {
    // The two rows whose decisionState disagrees with their served lane.
    expect(roleHeldCut.classification.decisionState).toBe("blocked");
    expect(targetIneligibleCut.classification.decisionState).toBe("act");

    const result = build();
    const lanes = new Map(result.ads.items.map((item) => [item.decisionId, item.lane]));
    expect(lanes.get("role-held-cut")).toBe("act");
    expect(lanes.get("target-cut")).toBe("blocked");
    expect(lanes.get("config-held-cut")).toBe("blocked");

    // Five served, ten decided: the tabs count all ten, by served lane.
    expect(result.ads.items).toHaveLength(5);
    expect(result.ads.statePreCapCounts).toEqual({ act: 2, blocked: 7, monitor: 1 });
    // Never the reader's decisionState buckets.
    expect(result.ads.statePreCapCounts).not.toEqual({ act: 99, blocked: 99, monitor: 99 });
    // Every served row's lane is the lane its pre-cap projection is counted in.
    for (const item of result.ads.items) {
      const decision = population.find((candidate) => candidate.decisionId === item.decisionId)!;
      expect(adOsLaneForCanonicalDecision(decision, eligibility, false)).toBe(item.lane);
    }
  });

  it("keeps a role-held Cut out of the Blocked held tally that says 'needs more evidence'", () => {
    const result = build();
    // Only the config-held Cut is a withheld verdict still in Blocked.
    expect(result.ads.heldCounts).toEqual({ scale: 0, cut: 1, refresh: 0 });
  });

  it("moves every Act row of a retained generation to review in the counts too", () => {
    const result = build(true);
    expect(result.ads.items.every((item) => item.lane !== "act")).toBe(true);
    expect(result.ads.statePreCapCounts).toEqual({ act: 0, blocked: 9, monitor: 1 });
  });
});

describe("an uncounted decision source is unknown, not zero", () => {
  it("serves null pre-cap counts for an unavailable source", () => {
    const model = nativeReadModel([]);
    model.status = "unavailable";
    model.source.status = "unavailable";
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: model,
      currency: "EUR",
    });
    expect(result.ads.items).toEqual([]);
    expect(result.ads.statePreCapCounts).toBeNull();
    expect(result.ads.eligiblePreCapCount).toBeNull();
  });

  it("serves true zeros for a verified-empty source", () => {
    const model = withPreCap(candidateEnvelope(nativeReadModel([]), [], 0), []);
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: model,
      currency: "EUR",
    });
    expect(result.ads.statePreCapCounts).toEqual({ act: 0, blocked: 0, monitor: 0 });
    expect(result.ads.eligiblePreCapCount).toBe(0);
  });

  it("omits the pending-inventory count when the active-Ad read was incomplete", () => {
    const base = {
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: withPreCap(candidateEnvelope(nativeReadModel([]), [], 0), []),
      currency: "EUR",
      currentAds: [],
    };
    const incomplete = buildMetaOsDecisionsPresentation({ ...base, currentAdsComplete: false });
    expect("pendingInventoryCount" in incomplete.ads).toBe(false);
    expect(incomplete.limitations.map((item) => item.code)).toContain("active_ad_inventory_unverified");

    const complete = buildMetaOsDecisionsPresentation({ ...base, currentAdsComplete: true });
    expect(complete.ads.pendingInventoryCount).toBe(0);
    expect(complete.limitations.map((item) => item.code)).not.toContain("active_ad_inventory_unverified");
  });
});

describe("the pre-cap projection gets the same request-time governance as the rows", () => {
  function eligibleNativeCut(id: string, adId: string, computedAt: string) {
    const decision = nativeAd(canonicalDecision({ id, adId, buyerAction: "cut" }));
    decision.sourceDecision.engineVersion = NATIVE_AD_ENGINE_VERSION;
    decision.sourceDecision.computedAt = computedAt;
    decision.sourceAuthority = {
      status: "native_exact",
      actionEligible: true,
      reviewOnlyReason: null,
      snapshotId: decision.sourceSnapshotId,
      evaluationId: "10000000-0000-4000-8000-000000000901",
      inputHash: "a".repeat(64),
      decisionHash: "b".repeat(64),
      providerAccountRefId: "30000000-0000-4000-8000-000000000001",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      realAdId: adId,
      authorizedAction: "cut",
      executionReadiness: "live_preflight_required",
      jobRunId: "20000000-0000-4000-8000-000000000001",
    } as never;
    return decision;
  }

  it("counts a kill-switched native Cut in Blocked even when the cap did not serve it", () => {
    const now = new Date("2026-09-24T10:00:00.000Z");
    const cut = eligibleNativeCut("capped-native-cut", "120000000000000901", "2026-09-24T06:00:00.000Z");
    const model = withPreCap(candidateEnvelope(nativeReadModel([]), [], 1), [cut]);
    const governed = applyMetaExecutionGovernanceToReadModel({
      model,
      governance: {
        verified: true,
        controlsConfigured: true,
        writeBlocked: true,
        blockReason: "META_ADS_WRITE_KILL_SWITCH",
      },
      pipeline: { verified: true, executionReady: true },
      now,
    });
    const hydrated = readMetaPreCapAdCandidates(governed);
    expect(hydrated?.[0]?.sourceAuthority?.executionReadiness).toBe("kill_switched");
    // The cached source projection is never mutated by one request's posture.
    expect(readMetaPreCapAdCandidates(model)?.[0]?.sourceAuthority?.executionReadiness).toBe(
      "live_preflight_required",
    );
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: governed,
      currency: "EUR",
    });
    expect(result.ads.statePreCapCounts).toEqual({ act: 0, blocked: 1, monitor: 0 });

    const open = applyMetaExecutionGovernanceToReadModel({
      model,
      governance: { verified: true, controlsConfigured: true, writeBlocked: false, blockReason: null },
      pipeline: { verified: true, executionReady: true },
      now,
    });
    expect(
      buildMetaOsDecisionsPresentation({
        actionNow: [],
        watching: [],
        nonSales: [],
        decisionReadModel: open,
        currency: "EUR",
      }).ads.statePreCapCounts,
    ).toEqual({ act: 1, blocked: 0, monitor: 0 });
  });

  it("never serializes the projection", () => {
    const hidden = eligibleNativeCut("never-serialized", "120000000000000902", "2026-09-24T06:00:00.000Z");
    const model = withPreCap(candidateEnvelope(nativeReadModel([]), [], 1), [hidden]);
    expect(JSON.stringify(model)).not.toContain("never-serialized");
  });
});
