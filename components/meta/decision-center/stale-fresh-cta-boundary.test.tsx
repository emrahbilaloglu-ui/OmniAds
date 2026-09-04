// D078 — STATIC (function-level) stale/fresh CTA proof. HONEST SCOPE
// (correction 2): this file constructs the read model in-test and therefore
// proves the presentation→adapter→render layers only — it does NOT invoke
// the `/api/meta/decisions-workspace` route or any database read. The
// authoritative actual-route proof lives in
// app/api/meta/decisions-workspace/route.lattice-cta.db.test.tsx (real GET,
// real ephemeral DB, only the provider-inventory boundary mocked), executed
// by the D078 local-UI harness and recorded as `routeCtaProof` in the
// acceptance matrix. This static complement stays because it is
// deterministic in every battery (the route proof is DB-gated) and pins the
// same arms:
//
//   evaluateDecisionOriginAdDecisionFreshness (the shared 12-hour evaluator)
//     → executionReadiness (derived exactly as the read model derives it)
//     → buildMetaOsDecisionsPresentation (the real server presentation)
//     → buildMetaDecisionCenterExactViewModel (the real client adapter)
//     → MetaDecisionCenterExact rendered HTML.
//
// Fixture shapes mirror lib/meta/decisions-os-presentation.test.ts.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { evaluateDecisionOriginAdDecisionFreshness } from "@/lib/creative-decision-engine/execution-safety";
import { buildMetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-presentation";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type { MetaDecisionsWorkspaceReadModel } from "@/lib/meta/decisions-workspace-contract";

vi.mock("@/lib/zero-base/language", () => ({
  useZeroBaseLanguage: () => "en",
}));

const { buildMetaDecisionCenterExactViewModel } = await import(
  "@/components/meta/decision-center/meta-decision-center-exact-adapter"
);
const { MetaDecisionCenterExact } = await import(
  "@/components/meta/decision-center/MetaDecisionCenterExact"
);

const NOW = new Date("2026-08-30T04:00:00.000Z");
const STALE_COMPUTED_AT = "2026-08-22T14:51:26.766Z"; // the real bundle cut's clock — 180h old
const FRESH_COMPUTED_AT = "2026-08-30T03:30:00.000Z"; // 30 minutes old

function provenance(recordId: string, field: string) {
  return { source: "test", field, recordId, asOf: "2026-08-29", version: null };
}

function canonicalCut(input: {
  id: string;
  adId: string;
  computedAt: string;
}): MetaCanonicalDecision {
  return {
    decisionId: input.id,
    episodeId: `${input.id}:episode`,
    episodeStartedAt: "2026-08-29",
    providerAccountId: "act_1",
    identityGrain: "ad",
    sourceSnapshotId: `${input.id}:snapshot`,
    sourceDecision: {
      label: "cut",
      preAuthorityLabel: "cut",
      authorityBlocker: null,
      rawLabel: "cut",
      reason: "Economic stop-loss below explicit break-even.",
      confidence: 0.75,
      confidenceBand: "high",
      truthSource: "commercial_truth",
      engineVersion: "v3-ad-test",
      snapshotAsOf: "2026-08-29",
      computedAt: input.computedAt,
      badges: [],
      provenance: provenance(input.id, "decision"),
    },
    parentChain: {
      account: { id: "act_1", name: "Account" },
      campaign: { id: "cmp_1", name: "Main campaign" },
      adset: { id: "set_1", name: "Broad" },
      ad: { id: input.adId, name: `Ad ${input.adId}` },
      creative: { id: `creative:${input.id}`, name: `Creative ${input.id}` },
      provenance: provenance(input.id, "identity"),
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
      provenance: provenance(input.id, "media"),
    },
    classification: {
      overlayVersion: "meta-decisions-classification-overlay.v4",
      queueSection: "creative_rotation",
      lifecycleRole: {
        value: "main",
        confidence: "high",
        trustedForAction: true,
        blockerCode: null,
        provenance: provenance(input.id, "role"),
      },
      assessment: {
        value: "below_target",
        blockerCode: null,
        provenance: provenance(input.id, "assessment"),
      },
      decisionState: "act",
      heldAction: null,
      legacyBuyerAction: "cut",
      buyerAction: "cut",
      buyerLabel: "cut",
      executionAction: null,
      resolution: null,
      blockers: [],
      provenance: provenance(input.id, "classification"),
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
      spend: 1277.78,
      purchases: 8,
      roas: 0.91,
      recent7dRoas: 0.58,
      effectiveTargetRoas: 2,
      ratioToTarget: 0.45,
      currency: "USD",
      attribution: "meta_attributed",
      provenance: provenance(input.id, "metrics"),
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
  } as MetaCanonicalDecision;
}

/**
 * Derive the source authority exactly as the read model does: the REAL
 * shared 12-hour evaluator decides freshness, and the readiness ladder below
 * is the read model's own ordering (authorized → engine version → freshness
 * → governance/pipeline, all open here).
 */
function withDerivedAuthority(
  decision: MetaCanonicalDecision,
  computedAt: string,
) {
  const freshness = evaluateDecisionOriginAdDecisionFreshness({
    computedAt,
    now: NOW,
  });
  const executionReadiness =
    freshness.status !== "fresh" ? "stale_decision" : "live_preflight_required";
  decision.sourceAuthority = {
    status: "native_exact",
    actionEligible: true,
    reviewOnlyReason: null,
    snapshotId: decision.sourceSnapshotId,
    evaluationId: "10000000-0000-4000-8000-000000000001",
    inputHash: "a".repeat(64),
    decisionHash: "b".repeat(64),
    providerAccountRefId: "30000000-0000-4000-8000-000000000001",
    engineVersion: "v3-ad-test",
    realAdId: decision.parentChain.ad!.id,
    authorizedAction: "cut",
    jobRunId: "20000000-0000-4000-8000-000000000001",
    executionReadiness,
    decisionFreshness: freshness,
  } as NonNullable<MetaCanonicalDecision["sourceAuthority"]>;
  return decision;
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
    generatedAt: "2026-08-30T04:00:00.000Z",
    scope: {
      businessId: "biz_1",
      providerAccountId: "act_1",
      decisionMode: "current",
      metricsRangeAffectsDecisionSnapshot: false,
    },
    unavailable: null,
    source: {
      status: "available",
      authority: "native_ad",
      table: "engine_v3_ad_decision_snapshots_daily",
      snapshotAsOf: "2026-08-29",
      computedAt: "2026-08-30T03:30:00.000Z",
      engineVersion: "v3-ad-test",
      fallbackReason: null,
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
  } as MetaDecisionsWorkspaceReadModel;
}

describe("stale/fresh mutation-CTA boundary — static presentation→adapter→render complement (D078)", () => {
  const stale = withDerivedAuthority(
    canonicalCut({ id: "stale-cut", adId: "120000000000000042", computedAt: STALE_COMPUTED_AT }),
    STALE_COMPUTED_AT,
  );
  const fresh = withDerivedAuthority(
    canonicalCut({ id: "fresh-cut", adId: "120000000000000043", computedAt: FRESH_COMPUTED_AT }),
    FRESH_COMPUTED_AT,
  );

  const os = buildMetaOsDecisionsPresentation({
    actionNow: [],
    watching: [],
    nonSales: [],
    decisionReadModel: readModel([stale, fresh]),
    pipelineHealth: { overall: "healthy", executionReady: true, blockers: [] },
    currency: "USD",
  });

  it("the real evaluator classified the two clocks as stale vs fresh (no hand-waved freshness)", () => {
    expect(stale.sourceAuthority?.decisionFreshness?.status).toBe("stale");
    expect(
      stale.sourceAuthority?.decisionFreshness?.ageHours,
    ).toBeGreaterThan(150);
    expect(fresh.sourceAuthority?.decisionFreshness?.status).toBe("fresh");
    expect(stale.sourceAuthority?.executionReadiness).toBe("stale_decision");
    expect(fresh.sourceAuthority?.executionReadiness).toBe(
      "live_preflight_required",
    );
  });

  it("the server presentation offers the mutation only on the fresh row, with live-preflight copy", () => {
    const staleItem = os.ads.items.find((item) => item.adId === "120000000000000042")!;
    const freshItem = os.ads.items.find((item) => item.adId === "120000000000000043")!;
    expect(staleItem.action).toMatchObject({
      code: "refresh_decision_data",
      label: "Refresh Decision",
      intent: "review",
      providerMutation: null,
    });
    expect(staleItem.lane).toBe("blocked");
    expect(freshItem.action).toMatchObject({
      label: "Cut",
      intent: "execute",
      providerMutation: "pause",
    });
    expect(freshItem.action.scopeNote).toMatch(/live preflight/i);
  });

  it("the rendered Decision Center shows the stale row's evidence with NO mutation CTA and the fresh row's supervised Cut", () => {
    const viewModel = buildMetaDecisionCenterExactViewModel({
      workspace: {
        decisionReadModel: readModel([stale, fresh]),
        os,
        lanes: {
          actionNow: [],
          watching: [],
          healthy: [],
          nonSales: [],
          archive: [],
          counts: { actionNow: 0, watching: 0, healthy: 0, nonSales: 0, archive: 0 },
          snapshotDate: "2026-08-29",
          snapshotCreatedAt: "2026-08-30T03:00:00.000Z",
          structureInventory: [],
          deferredIds: [],
          snapshotHealth: null,
        },
        queue: { groups: [], actionStates: {} },
        system: { currency: "USD" },
        pulse: {
          businessId: "biz_1",
          campaignRoleCoverage: null,
          pacing: {
            spendToday: null,
            conversionsToday: null,
            mtdSpend: null,
            mtdTarget: null,
            dayPace: null,
            dailyTarget: null,
          },
          roas: {
            selected: null,
            target: null,
            targetFreshness: null,
            trend: [],
          },
          window: "28d",
          lastSyncAt: "2026-08-30T03:00:00.000Z",
          engineVersion: "v3-ad-test",
          currency: "USD",
          dataReadiness: null,
          snapshotHealth: null,
        },
        window: "28d",
        startDate: "2026-08-02",
        endDate: "2026-08-29",
      } as never,
      now: NOW,
    });
    const blockedHtml = renderToStaticMarkup(
      <MetaDecisionCenterExact
        lane="needsres"
        viewModel={viewModel}
        scope="creatives"
      />,
    );
    const actionHtml = renderToStaticMarkup(
      <MetaDecisionCenterExact
        lane="action"
        viewModel={viewModel}
        scope="creatives"
      />,
    );

    // Each row renders in the lane served by the decision state.
    expect(blockedHtml).toContain("120000000000000042");
    expect(blockedHtml).not.toContain("120000000000000043");
    expect(actionHtml).toContain("120000000000000043");
    expect(actionHtml).not.toContain("120000000000000042");

    // The stale row: review-only Refresh Decision; no enabled Cut control
    // anywhere in its card.
    const staleCard = blockedHtml.match(
      /<[^>]*data-decision-id="stale-cut"[\s\S]*?(?=data-decision-id="|$)/,
    )?.[0] ?? blockedHtml;
    expect(staleCard).toContain("Refresh Decision");
    expect(staleCard).not.toMatch(/<button[^>]*(?<!disabled[^>]*)>\s*Cut\s*</);

    // The fresh row: the supervised Cut with explicit live-preflight copy.
    expect(actionHtml).toContain("Cut");
    expect(actionHtml).toMatch(/live preflight/i);
  });
});
