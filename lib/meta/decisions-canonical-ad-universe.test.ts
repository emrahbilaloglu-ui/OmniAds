/**
 * THE CANONICAL AD UNIVERSE MUST SURVIVE THE ROUTE'S OWN PIPELINE.
 *
 * The read model serves only the CAPPED selection of exact-Ad candidates, but
 * the presentation needs the full identity universe to tell two different
 * things apart:
 *
 *   - an ACTIVE Ad no producer has decided        -> un-decided inventory
 *   - an exact decision the response cap omitted  -> a decision, just not on
 *                                                    this page
 *
 * It carried that universe as a non-enumerable `Symbol.for(...)` property on
 * the read model. `structuredClone` DROPS non-enumerable symbol-keyed
 * properties — demonstrated here rather than asserted — and the route runs
 *
 *     readMetaDecisionsWorkspaceReadModel        (attaches the universe)
 *       -> applyMetaExecutionGovernanceToReadModel  (structuredClone)
 *       -> buildMetaOsDecisionsPresentation         (reads the universe)
 *
 * so by the time the presentation asked, the answer was always `null` and it
 * fell back to the capped ids. Every real decision the cap omitted was then
 * counted as un-decided ACTIVE inventory: on an account serving 60 of 80, that
 * is 20 decided Ads reported to the operator as "no decision exists yet".
 *
 * The bug needs more than 60 Ads to appear at all, which is why no
 * fixture-shaped test caught it. These drive the real three-stage order.
 */
import { describe, expect, it } from "vitest";

import { buildMetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-presentation";
import { applyMetaExecutionGovernanceToReadModel } from "@/lib/meta/decisions-workspace-read-model";
import { projectMetaDecisionSemantics } from "@/lib/meta/decision-semantics";
import type { MetaDecisionsWorkspaceReadModel } from "@/lib/meta/decisions-workspace-contract";

const CANONICAL_AD_UNIVERSE = Symbol.for(
  "adsecute.meta.decisions.canonical-ad-universe",
);

describe("structuredClone and a non-enumerable symbol", () => {
  it("drops it, which is the whole mechanism", () => {
    const carrier: Record<string, unknown> = { kept: true };
    Object.defineProperty(carrier, CANONICAL_AD_UNIVERSE, {
      value: new Set(["120000000000000001"]),
      enumerable: false,
      configurable: false,
      writable: false,
    });

    expect(
      (carrier as { [CANONICAL_AD_UNIVERSE]?: ReadonlySet<string> })[
        CANONICAL_AD_UNIVERSE
      ],
    ).toBeInstanceOf(Set);

    const cloned = structuredClone(carrier);
    expect(cloned.kept).toBe(true);
    expect(
      (cloned as { [CANONICAL_AD_UNIVERSE]?: ReadonlySet<string> })[
        CANONICAL_AD_UNIVERSE
      ],
    ).toBeUndefined();
  });
});

function adId(index: number): string {
  return `1200000000000${String(index).padStart(5, "0")}`;
}

/**
 * A read model in the shape the presentation consumes: 60 SERVED exact-Ad
 * candidates out of an 80-Ad eligible population.
 *
 * Only the fields the presentation reads are populated. The point of the test
 * is the identity universe, not the decision payloads, and every served row is
 * deliberately identical apart from its ad id.
 */
function readModelWithCap(input: {
  servedCount: number;
  eligibleCount: number;
  attachUniverse: boolean;
  /** When set, every served row is that verdict, HELD. */
  held?: "scale" | "cut" | "refresh";
}): MetaDecisionsWorkspaceReadModel {
  const served = Array.from({ length: input.servedCount }, (_, index) =>
    canonicalAdDecision(adId(index + 1), input.held),
  );
  const model = {
    status: "available",
    source: {
      status: "available",
      authority: "native_ad",
      snapshotAsOf: "2026-09-07",
      engineVersion: "v3-test",
      fallbackReason: null,
      table: "engine_v3_ad_decision_snapshots_daily",
    },
    queue: {
      adCandidates: {
        selectionVersion: "meta-decisions-ad-candidate-selection.v2",
        limit: input.servedCount,
        preCapCount: input.eligibleCount,
        eligiblePreCapCount: input.eligibleCount,
        selectedCount: served.length,
        stateCounts: input.held
          ? {
              act: { preCapCount: 0, selectedCount: 0 },
              blocked: {
                preCapCount: input.eligibleCount,
                selectedCount: served.length,
              },
              monitor: { preCapCount: 0, selectedCount: 0 },
            }
          : {
              act: {
                preCapCount: input.eligibleCount,
                selectedCount: served.length,
              },
              blocked: { preCapCount: 0, selectedCount: 0 },
              monitor: { preCapCount: 0, selectedCount: 0 },
            },
        omittedAmbiguousIdentity: 0,
        omittedWithoutVerifiedAdId: 0,
        omittedNotApplicable: 0,
        items: served,
      },
      sourcePreCapCount: input.eligibleCount,
      inactiveAssets: { count: 0, items: [] },
      omittedFromQueue: { count: 0, reasons: [] },
    },
    capabilities: {},
  } as unknown as MetaDecisionsWorkspaceReadModel;

  if (input.attachUniverse) {
    // The full eligible population, exactly as the real reader attaches it:
    // every identity-eligible candidate, not only the ones the cap served.
    Object.defineProperty(model, CANONICAL_AD_UNIVERSE, {
      value: new Set(
        Array.from({ length: input.eligibleCount }, (_, index) =>
          adId(index + 1),
        ),
      ),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return model;
}

function canonicalAdDecision(
  id: string,
  held?: "scale" | "cut" | "refresh",
) {
  /*
   * The REAL semantics projector decides the classification for a held row.
   *
   * Hand-writing `decisionState`, `buyerAction` and `resolution` here would
   * make the fixture agree with itself and prove nothing: the pairing that
   * matters — held verdict, blocked state, null buyer action, and the
   * resolution belonging to THAT verdict — is the projector's own output.
   */
  const semantics = held
    ? projectMetaDecisionSemantics({
        legacyBuyerAction: held,
        // The published compatibility label, which is what an operator saw
        // instead of the held verdict.
        sourceLabel: "keep",
        lifecycleRole: "main",
        badgeCodes: [],
        blockerCodes: [],
        heldAction: held,
        authorityBlocker: "source_freshness",
      })
    : null;
  const decision = {
    decisionId: `decision:${id}`,
    episodeId: `decision:${id}:episode`,
    episodeStartedAt: "2026-09-01",
    providerAccountId: "act_1",
    identityGrain: "ad",
    sourceSnapshotId: `decision:${id}:snapshot`,
    sourceDecision: {
      label: "keep",
      preAuthorityLabel: "keep",
      authorityBlocker: null,
      rawLabel: "keep",
      reason: "Persisted server decision.",
      confidence: 0.8,
      confidenceBand: "high",
      truthSource: "commercial_truth",
      engineVersion: "v3-test",
      snapshotAsOf: "2026-09-07",
      computedAt: "2026-09-07T04:00:00.000Z",
      badges: [],
      provenance: {
        source: "test",
        field: "decision",
        recordId: id,
        asOf: "2026-09-07",
        version: "v3-test",
      },
    },
    parentChain: {
      account: { id: "act_1", name: "Account" },
      campaign: { id: "cmp_1", name: "Main campaign" },
      adset: { id: "set_1", name: "Broad" },
      ad: { id, name: `Ad ${id}` },
      creative: { id: `creative:${id}`, name: `Creative ${id}` },
      provenance: {
        source: "test",
        field: "identity",
        recordId: id,
        asOf: "2026-09-07",
        version: null,
      },
    },
    identityResolution: {
      basis: "single_ad_creative_equivalent",
      candidateAdCount: 1,
      metricsEquivalent: true,
      adActionEligible: true,
    },
    media: {
      state: "missing",
      missingMedia: true,
      thumbnail: { state: "missing", url: null },
      provenance: {
        source: "test",
        field: "media",
        recordId: id,
        asOf: "2026-09-07",
        version: null,
      },
    },
    classification: {
      overlayVersion: "meta-decisions-classification-overlay.v4",
      queueSection: "creative_rotation",
      lifecycleRole: {
        value: "main",
        confidence: "high",
        trustedForAction: true,
        blockerCode: null,
        provenance: {
          source: "test",
          field: "role",
          recordId: id,
          asOf: "2026-09-07",
          version: null,
        },
      },
      assessment: {
        value: "stable",
        blockerCode: null,
        provenance: {
          source: "test",
          field: "assessment",
          recordId: id,
          asOf: "2026-09-07",
          version: null,
        },
      },
      decisionState: "monitor",
      buyerAction: "protect",
      heldAction: null,
      blockedActionType: null,
      blockers: [],
      resolution: null,
      reviewOnlyReason: null,
      provenance: {
        source: "test",
        field: "classification",
        recordId: id,
        asOf: "2026-09-07",
        version: null,
      },
    },
    metrics: {
      spend: 100,
      purchases: 4,
      roas: 2.4,
      recent7dRoas: 2.2,
      effectiveTargetRoas: 1.8,
      ratioToTarget: 1.33,
      currency: "USD",
      attribution: "meta_attributed",
      provenance: {
        source: "test",
        field: "metrics",
        recordId: id,
        asOf: "2026-09-07",
        version: null,
      },
    },
    exposure: null,
    exposureUnavailableReason: null,
    history: {
      events: { status: "available", reason: null, preCapCount: 0, items: [] },
      outcomes: { status: "available", reason: null, items: [] },
      responses: { status: "unavailable", reason: "not_keyed" },
      providerWrites: { status: "unavailable", reason: "not_keyed" },
    },
    riskTier: null,
    riskTierProvenance: { status: "proposed", reason: "not_persisted" },
    promotionBasis: {
      status: "proposed",
      value: null,
      reason: "not_persisted",
    },
  };
  if (!semantics) return decision;
  return {
    ...decision,
    sourceDecision: {
      ...decision.sourceDecision,
      // Published as the soft compatibility label; the hard verdict is what
      // the engine reached before the freshness gate withheld it.
      label: "keep",
      rawLabel: "keep",
      preAuthorityLabel: held,
      authorityBlocker: "source_freshness",
    },
    classification: {
      ...decision.classification,
      decisionState: semantics.decisionState,
      buyerAction: semantics.buyerAction,
      heldAction: semantics.heldAction,
      blockedActionType: semantics.heldAction,
      resolution: semantics.resolution,
    },
  };
}

/** Every ACTIVE Ad in the eligible population, as provider inventory. */
function currentAds(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    providerAccountId: "act_1",
    adId: adId(index + 1),
    adName: `Ad ${adId(index + 1)}`,
    campaignId: "cmp_1",
    adsetId: "set_1",
    creativeId: `creative:${adId(index + 1)}`,
    configuredStatus: "ACTIVE",
    effectiveStatus: "ACTIVE",
    providerUpdatedAt: null,
    fetchedAt: "2026-09-07T09:00:00.000Z",
  }));
}

function presentationThroughRouteOrder(model: MetaDecisionsWorkspaceReadModel) {
  // The route's own order, and the reason this file exists: the governance step
  // sits BETWEEN the reader and the presentation.
  // @see app/api/meta/decisions-workspace/route.ts
  const governed = applyMetaExecutionGovernanceToReadModel({
    model,
    governance: {
      liveWritesEnabled: false,
      killSwitchEngaged: false,
      controlRowPresent: false,
      businessStop: false,
    } as never,
    pipeline: { verified: false, executionReady: false },
    now: new Date("2026-09-07T12:00:00.000Z"),
  });
  return buildMetaOsDecisionsPresentation({
    actionNow: [],
    watching: [],
    nonSales: [],
    decisionReadModel: governed,
    currentAds: currentAds(80),
    currency: "USD",
  });
}

describe("a capped-out decision is a decision, not un-decided inventory", () => {
  it("counts zero pending inventory when every ACTIVE Ad has a decision", () => {
    /*
     * 80 ACTIVE Ads, 80 eligible decisions, 60 served by the cap.
     *
     * The correct answer is ZERO un-decided inventory: every one of those Ads
     * was decided, and 20 of them simply did not fit on this page. Before the
     * universe survived the clone, this reported 20 — real verdicts described
     * to the operator as evidence that does not exist yet.
     */
    const result = presentationThroughRouteOrder(
      readModelWithCap({
        servedCount: 60,
        eligibleCount: 80,
        attachUniverse: true,
      }),
    );

    expect(result.ads.items).toHaveLength(60);
    expect(result.ads.pendingInventoryCount).toBe(0);
    expect(
      result.limitations.map((limitation) => limitation.code),
    ).not.toContain("active_ad_inventory_pending_native_decision");
  });

  it("still counts an ACTIVE Ad that genuinely has no decision", () => {
    /*
     * The guard against over-correcting into silence: 80 ACTIVE Ads but only
     * 70 eligible decisions, so 10 really are un-decided and must be counted
     * however the cap falls.
     */
    const result = presentationThroughRouteOrder(
      readModelWithCap({
        servedCount: 60,
        eligibleCount: 70,
        attachUniverse: true,
      }),
    );

    expect(result.ads.items).toHaveLength(60);
    expect(result.ads.pendingInventoryCount).toBe(10);
    expect(
      result.limitations.map((limitation) => limitation.code),
    ).toContain("active_ad_inventory_pending_native_decision");
  });

  it("falls back to the served ids when no universe was attached at all", () => {
    /*
     * A reader that attaches nothing is a different case from one whose
     * attachment was lost in transit, and it must stay fail-closed rather than
     * silently claiming full coverage: with no universe, only the served ids
     * are known to be decided, so the other 20 are reported as pending.
     *
     * This is the OLD behaviour, and pinning it is what makes the first test
     * meaningful — it is the number the clone defect produced on every request.
     */
    const result = presentationThroughRouteOrder(
      readModelWithCap({
        servedCount: 60,
        eligibleCount: 80,
        attachUniverse: false,
      }),
    );

    expect(result.ads.pendingInventoryCount).toBe(20);
  });
});

describe("a held verdict survives the same route order", () => {
  it("tallies the held verdicts over the SERVED page, beside the lane counts", () => {
    /*
     * 80 eligible held Refresh verdicts, 60 served by the cap.
     *
     * Every one of them publishes the soft compatibility label `keep`, so
     * before the held verdict was served the operator's only reading of this
     * page was 60 rows saying "Keep Running" — and the Refresh pipeline, which
     * selects on the served verdict, saw none of them.
     */
    const result = presentationThroughRouteOrder(
      readModelWithCap({
        servedCount: 60,
        eligibleCount: 80,
        attachUniverse: true,
        held: "refresh",
      }),
    );

    expect(result.ads.items).toHaveLength(60);
    expect(result.ads.heldCounts).toEqual({ scale: 0, cut: 0, refresh: 60 });
    // The same 60 rows, counted once in their lane. The held tally is a second
    // reading of them, never a fourth lane.
    expect(result.ads.blockedCount).toBe(60);
    expect(result.ads.actCount).toBe(0);
    expect(result.ads.monitorCount).toBe(0);
    // Post-cap, exactly like the three lane counts it sits beside: the
    // pre-cap population is served separately and is 80, not 60.
    expect(result.ads.statePreCapCounts.blocked).toBe(80);
    // Still decisions, so still not un-decided inventory.
    expect(result.ads.pendingInventoryCount).toBe(0);

    for (const item of result.ads.items) {
      expect(item.publishedLabel).toBe("keep");
      expect(item.heldAction).toBe("refresh");
      expect(item.heldResolution).not.toBeNull();
      expect(item.action.providerMutation).toBeNull();
      expect(item.action.intent).not.toBe("execute");
    }
  });
});
