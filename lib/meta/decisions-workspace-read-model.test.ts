import { beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import * as db from "@/lib/db";
import {
  buildMetaDecisionsWorkspaceReadModel,
  buildUnavailableMetaDecisionsWorkspaceReadModel,
  readMetaDecisionsWorkspaceReadModel,
  type MetaDecisionCampaignContextSourceRow,
  type MetaDecisionIdentitySourceRow,
  type MetaDecisionSnapshotSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/creative-decision-engine/campaign-context/source", () => ({
  resolveCampaignContextMode: vi.fn(() => "automatic"),
}));

function snapshot(
  creativeId: string,
  overrides: Partial<MetaDecisionSnapshotSourceRow> = {},
): MetaDecisionSnapshotSourceRow {
  return {
    snapshot_id: `snapshot-${creativeId}`,
    provider_account_id: "act_1",
    creative_id: creativeId,
    as_of_date: "2026-07-10",
    engine_version: "v3-test",
    scope_type: "account",
    scope_id: "*",
    label: "scale",
    raw_label: null,
    confidence: 82,
    truth_source: "commercial_truth",
    effective_target_roas: 2,
    ratio_to_target: 1.4,
    badges: [],
    reason: "Persisted winner evidence.",
    spend: 100,
    purchases: 8,
    roas: 2.8,
    recent7d_roas: 2.6,
    label_transform: null,
    blocked_action_type: null,
    computed_at: "2026-07-10T05:00:00.000Z",
    episode_started_at: "2026-07-08",
    ...overrides,
  };
}

function identity(
  creativeId: string,
  overrides: Partial<MetaDecisionIdentitySourceRow> = {},
): MetaDecisionIdentitySourceRow {
  const adId = `120000000${String(
    [...creativeId].reduce(
      (sum, character, index) => sum + character.charCodeAt(0) * (index + 1),
      0,
    ),
  ).padStart(9, "0")}`;
  return {
    provider_account_id: "act_1",
    creative_id: creativeId,
    creative_name: `Creative ${creativeId}`,
    campaign_id: "cmp_1",
    campaign_name: "Main Sales",
    adset_id: "adset_1",
    adset_name: "Broad",
    ad_id: adId,
    ad_name: `Ad ${creativeId}`,
    candidate_ad_count: 1,
    currency: "USD",
    thumbnail_url: `https://cdn.example/${creativeId}.jpg`,
    media_source_present: true,
    media_available: true,
    media_source: "meta_creative_media",
    source_updated_at: "2026-07-10T04:00:00.000Z",
    ...overrides,
  };
}

function context(
  overrides: Partial<MetaDecisionCampaignContextSourceRow> = {},
): MetaDecisionCampaignContextSourceRow {
  return {
    campaignId: "cmp_1",
    kind: "main",
    source: "persisted_label",
    confidenceClass: "high",
    sourceUpdatedAt: "2026-07-09T10:00:00.000Z",
    resolverVersion: "user",
    ...overrides,
  };
}

describe("Meta Decisions workspace canonical read model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps decision and episode ids stable across daily snapshots without dates in the ids", () => {
    const base = {
      businessId: "biz_1",
      providerAccountId: "act_1",
      identityRows: [identity("creative_1")],
      campaignContextRows: [context()],
      generatedAt: "2026-07-10T12:00:00.000Z",
    };
    const first = buildMetaDecisionsWorkspaceReadModel({
      ...base,
      snapshotRows: [snapshot("creative_1")],
    });
    const second = buildMetaDecisionsWorkspaceReadModel({
      ...base,
      snapshotRows: [
        snapshot("creative_1", {
          snapshot_id: "snapshot-next-day",
          as_of_date: "2026-07-11",
          engine_version: "v3-next",
          computed_at: "2026-07-11T05:00:00.000Z",
        }),
      ],
    });
    const nextEpisode = buildMetaDecisionsWorkspaceReadModel({
      ...base,
      snapshotRows: [
        snapshot("creative_1", {
          snapshot_id: "snapshot-new-episode",
          as_of_date: "2026-07-12",
          episode_started_at: "2026-07-12",
        }),
      ],
    });

    const firstItem = first.queue.sections.creative_rotation.items[0]!;
    const secondItem = second.queue.sections.creative_rotation.items[0]!;
    const nextEpisodeItem =
      nextEpisode.queue.sections.creative_rotation.items[0]!;
    expect(secondItem.decisionId).toBe(firstItem.decisionId);
    expect(secondItem.episodeId).toBe(firstItem.episodeId);
    expect(nextEpisodeItem.decisionId).toBe(firstItem.decisionId);
    expect(nextEpisodeItem.episodeId).not.toBe(firstItem.episodeId);
    expect(firstItem.decisionId).not.toContain("2026");
    expect(firstItem.episodeId).not.toContain("2026");
  });

  it("emits server-owned classification, hierarchy/media truth, and highest ceremony for missing risk", () => {
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [
        snapshot("creative_1", {
          label: "refresh",
          badges: [
            {
              type: "fatigue_fatigued",
              label: "Fatigued",
              severity: "warning",
            },
          ],
        }),
      ],
      identityRows: [identity("creative_1")],
      campaignContextRows: [context({ kind: "test" })],
      eventRows: [
        {
          id: "event_1",
          creative_id: "creative_1",
          event_date: "2026-07-10",
          event_type: "decision_changed",
          previous_label: "keep",
          current_label: "refresh",
          operator_action_type: null,
          notes: "Persisted transition.",
          pre_cap_count: 1,
        },
      ],
      outcomeRows: [
        {
          id: "outcome_1",
          decision_snapshot_id: "snapshot-creative_1",
          outcome_window_days: 7,
          evaluation_date: "2026-07-17",
          realized_outcome: "positive",
          severity: "medium",
          classifier_version: "outcomes.v1",
        },
      ],
      generatedAt: "2026-07-10T12:00:00.000Z",
    });

    const item = model.queue.sections.creative_rotation.items[0]!;
    expect(item.classification).toMatchObject({
      queueSection: "creative_rotation",
      buyerAction: "refresh",
      executionAction: null,
      lifecycleRole: { value: "test", trustedForAction: true },
      assessment: { value: "fatigued_former_winner", blockerCode: null },
    });
    expect(item.parentChain).toMatchObject({
      account: { id: "act_1" },
      campaign: { id: "cmp_1", name: "Main Sales" },
      adset: { id: "adset_1", name: "Broad" },
      ad: { id: expect.stringMatching(/^\d+$/), name: "Ad creative_1" },
      creative: { id: "creative_1", name: "Creative creative_1" },
    });
    expect(item.media).toMatchObject({
      state: "available",
      missingMedia: false,
      thumbnail: {
        state: "available",
        url: "https://cdn.example/creative_1.jpg",
      },
    });
    expect(item.riskTier).toBeNull();
    expect(item.confirmationCeremony).toBe("highest");
    expect(item.sourceDecision.confidenceBand).toBe("high");
    expect(item.metrics).toMatchObject({
      spend: 100,
      purchases: 8,
      roas: 2.8,
      recent7dRoas: 2.6,
      effectiveTargetRoas: 2,
      ratioToTarget: 1.4,
      currency: "USD",
      attribution: "meta_attributed",
    });
    expect(
      item.classification.blockers.map((blocker) => blocker.code),
    ).toContain("risk_tier_unclassified");
    expect(item.promotionBasis).toEqual({
      status: "proposed",
      value: null,
      reason: "promotion_basis_not_persisted",
    });
    expect(item.history).toMatchObject({
      events: {
        status: "available",
        preCapCount: 1,
        items: [
          { id: "event_1", actor: null, actorAttributionStatus: "unavailable" },
        ],
      },
      outcomes: {
        status: "available",
        items: [
          {
            id: "outcome_1",
            outcomeWindowDays: 7,
            realizedOutcome: "positive",
          },
        ],
      },
      responses: { status: "unavailable" },
      providerWrites: { status: "unavailable" },
    });
  });

  it("never promotes a synthetic grouped creative id to an actionable Meta ad", () => {
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [snapshot("creative_1")],
      identityRows: [
        identity("creative_1", {
          ad_id: "creative_synthetic",
          candidate_ad_count: 1,
        }),
      ],
      campaignContextRows: [context()],
    });

    const item = model.queue.sections.creative_rotation.items[0]!;
    expect(item.parentChain.ad).toBeNull();
    expect(item.identityResolution).toMatchObject({
      basis: "unresolved",
      adActionEligible: false,
    });
    expect(model.queue.adCandidates?.items).toEqual([]);
  });

  it("caps each section from true pre-cap rows and never aggregates exposure across currencies", () => {
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [
        snapshot("creative_usd", { spend: 100 }),
        snapshot("creative_eur", { spend: 200 }),
        snapshot("creative_unknown", { spend: 300 }),
      ],
      identityRows: [
        identity("creative_usd", { currency: "USD", candidate_ad_count: 1 }),
        identity("creative_eur", { currency: "EUR", candidate_ad_count: 1 }),
        identity("creative_unknown", { currency: null, candidate_ad_count: 1 }),
      ],
      campaignContextRows: [context()],
      generatedAt: "2026-07-10T12:00:00.000Z",
      sectionLimit: 2,
    });

    const section = model.queue.sections.creative_rotation;
    expect(section.preCapCount).toBe(3);
    expect(section.selectedCount).toBe(2);
    expect(section.items).toHaveLength(2);
    expect(section.items.some((item) => item.exposure === null)).toBe(true);
    expect(section.suppressionReceipt).toMatchObject({
      topN: 2,
      preCapCount: 3,
      selectedCount: 2,
      suppressedCount: 1,
      reasons: [{ code: "section_top_n_ranked", count: 1 }],
    });
    expect(section.exposureDigest).toEqual({
      basis: "pre_cap",
      byCurrency: [
        { currency: "EUR", amount: 200, decisionCount: 1 },
        { currency: "USD", amount: 100, decisionCount: 1 },
      ],
      unavailableCount: 1,
      crossCurrencyTotal: null,
    });
    expect(model.queue.adCandidates).toMatchObject({
      preCapCount: 3,
      eligiblePreCapCount: 3,
      selectedCount: 3,
      omittedAmbiguousIdentity: 0,
      omittedWithoutVerifiedAdId: 0,
    });
    expect(model.queue.adCandidates?.items).toHaveLength(3);
  });

  it("keeps 203 source decisions inside the server top-N and compressed payload budget", () => {
    const sourceCount = 203;
    const creativeIds = Array.from(
      { length: sourceCount },
      (_, index) => `creative_stress_${index + 1}`,
    );
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: creativeIds.map((creativeId, index) =>
        snapshot(creativeId, {
          spend: index + 1,
          confidence: 60 + (index % 35),
        }),
      ),
      identityRows: creativeIds.map((creativeId) => identity(creativeId)),
      campaignContextRows: [context()],
      generatedAt: "2026-07-10T12:00:00.000Z",
      sectionLimit: 7,
    });

    const section = model.queue.sections.creative_rotation;
    expect(section).toMatchObject({
      preCapCount: sourceCount,
      selectedCount: 7,
      suppressionReceipt: {
        topN: 7,
        preCapCount: sourceCount,
        selectedCount: 7,
        suppressedCount: sourceCount - 7,
      },
    });
    expect(section.items).toHaveLength(7);
    expect(section.exposureDigest).toMatchObject({
      basis: "pre_cap",
      byCurrency: [
        {
          currency: "USD",
          amount: (sourceCount * (sourceCount + 1)) / 2,
          decisionCount: sourceCount,
        },
      ],
      crossCurrencyTotal: null,
    });
    expect(gzipSync(JSON.stringify(model)).byteLength).toBeLessThanOrEqual(
      200_000,
    );
  });

  it("selects exact ads after state classification so Monitoring cannot starve Act Now", () => {
    const monitoringIds = Array.from(
      { length: 100 },
      (_, index) => `monitoring_${index + 1}`,
    );
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [
        ...monitoringIds.map((creativeId) =>
          snapshot(creativeId, {
            label: "test_more",
            confidence: 95,
            spend: 1000,
          }),
        ),
        snapshot("urgent_cut", {
          label: "cut",
          confidence: 40,
          spend: 10,
        }),
      ],
      identityRows: [
        ...monitoringIds.map((creativeId) => identity(creativeId)),
        identity("urgent_cut"),
      ],
      campaignContextRows: [context()],
    });

    expect(model.queue.adCandidates).toMatchObject({
      selectionVersion: "meta-decisions-ad-candidate-selection.v2",
      eligiblePreCapCount: 101,
      selectedCount: 60,
      stateCounts: {
        act: { preCapCount: 1, selectedCount: 1 },
        blocked: { preCapCount: 0, selectedCount: 0 },
        monitor: { preCapCount: 100, selectedCount: 59 },
      },
    });
    expect(
      model.queue.adCandidates?.items.some(
        (item) => item.parentChain.creative.id === "urgent_cut",
      ),
    ).toBe(true);
  });

  it("expands the same server ordering when the Ads candidate limit increases", () => {
    const creativeIds = Array.from(
      { length: 140 },
      (_, index) => `expand_${index + 1}`,
    );
    const base = {
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: creativeIds.map((creativeId) =>
        snapshot(creativeId, { label: "test_more" }),
      ),
      identityRows: creativeIds.map((creativeId) => identity(creativeId)),
      campaignContextRows: [context()],
    };
    const first = buildMetaDecisionsWorkspaceReadModel(base);
    const expanded = buildMetaDecisionsWorkspaceReadModel({
      ...base,
      adCandidateLimit: 120,
    });

    expect(first.queue.adCandidates).toMatchObject({
      limit: 60,
      eligiblePreCapCount: 140,
      selectedCount: 60,
    });
    expect(expanded.queue.adCandidates).toMatchObject({
      limit: 120,
      eligiblePreCapCount: 140,
      selectedCount: 120,
    });
    expect(
      expanded.queue.adCandidates?.items
        .slice(0, 60)
        .map((item) => item.decisionId),
    ).toEqual(
      first.queue.adCandidates?.items.map((item) => item.decisionId),
    );
  });

  it("serves a held cut as blocked resolution without erasing its assessment", () => {
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [
        snapshot("held_cut", {
          label: "diagnose",
          blocked_action_type: "cut",
          badges: [
            {
              type: "campaign_context_unresolved",
              label: "Campaign context unresolved",
              severity: "warning",
            },
            {
              type: "stop_loss_review",
              label: "Stop-loss review",
              severity: "warning",
            },
          ],
        }),
      ],
      identityRows: [identity("held_cut")],
      campaignContextRows: [],
    });

    const item = model.queue.sections.creative_rotation.items[0]!;
    expect(item.classification).toMatchObject({
      decisionState: "blocked",
      heldAction: "cut",
      buyerAction: null,
      legacyBuyerAction: "diagnose_data",
      assessment: { value: "below_target" },
      resolution: {
        code: "resolve_campaign_role",
        owner: "system",
      },
    });
  });

  it("serves ordinary keep and out-of-scope as explicit D035 states", () => {
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [
        snapshot("stable_keep", { label: "keep" }),
        snapshot("not_applicable", { label: "out_of_scope" }),
      ],
      identityRows: [identity("stable_keep"), identity("not_applicable")],
      campaignContextRows: [context()],
    });

    const items = model.queue.sections.creative_rotation.items;
    const stable = items.find(
      (item) => item.parentChain.creative.id === "stable_keep",
    );
    const notApplicable = items.find(
      (item) => item.parentChain.creative.id === "not_applicable",
    );
    expect(stable?.classification).toMatchObject({
      decisionState: "monitor",
      assessment: { value: "stable" },
      legacyBuyerAction: "protect",
      buyerAction: "protect",
      resolution: null,
    });
    expect(notApplicable?.classification).toMatchObject({
      decisionState: "not_applicable",
      assessment: { value: "out_of_scope" },
      legacyBuyerAction: "protect",
      buyerAction: null,
      resolution: null,
    });
    expect(model.queue.adCandidates?.omittedNotApplicable).toBe(1);
  });

  it("uses typed unavailable and named blocker states instead of inventing missing producers", () => {
    const unavailable = buildUnavailableMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: null,
      code: "provider_account_required",
      message: "providerAccountId is required.",
      generatedAt: "2026-07-10T12:00:00.000Z",
    });
    expect(unavailable).toMatchObject({
      status: "unavailable",
      scope: {
        providerAccountId: null,
        metricsRangeAffectsDecisionSnapshot: false,
      },
      unavailable: { code: "provider_account_required" },
      capabilities: {
        riskTierProducer: { status: "proposed" },
        promotionBasisProducer: { status: "proposed" },
        responseAttribution: { status: "unavailable" },
      },
    });

    const unresolved = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [snapshot("creative_1")],
      identityRows: [
        identity("creative_1", {
          media_source_present: true,
          media_available: false,
          thumbnail_url: null,
        }),
      ],
      campaignContextRows: [],
      generatedAt: "2026-07-10T12:00:00.000Z",
    });
    const item = unresolved.queue.sections.creative_rotation.items[0]!;
    expect(item.classification).toMatchObject({
      decisionState: "blocked",
      legacyBuyerAction: "diagnose_data",
      buyerAction: null,
      resolution: {
        code: "resolve_campaign_role",
        category: "campaign_context",
        owner: "system",
      },
    });
    expect(item.classification.lifecycleRole).toMatchObject({
      value: "label_needed",
      trustedForAction: false,
      blockerCode: "campaign_context_unresolved",
    });
    expect(
      item.classification.blockers.map((blocker) => blocker.code),
    ).toContain("campaign_context_unresolved");
    expect(item.media).toMatchObject({
      state: "missing",
      missingMedia: true,
      thumbnail: { state: "missing", url: null },
    });
  });

  it("never calls fallback-scale evidence a proven winner", () => {
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [
        snapshot("thin", {
          label: "scale",
          truth_source: "account_baseline_thin",
        }),
        snapshot("relative", {
          label: "scale",
          truth_source: "account_baseline",
        }),
      ],
      identityRows: [identity("thin"), identity("relative")],
      campaignContextRows: [context()],
      generatedAt: "2026-07-10T12:00:00.000Z",
    });

    const items = model.queue.sections.creative_rotation.items;
    const thin = items.find((item) => item.parentChain.creative.id === "thin")!;
    const relative = items.find(
      (item) => item.parentChain.creative.id === "relative",
    )!;
    expect(thin.classification.assessment).toMatchObject({
      value: "evidence_incomplete",
      blockerCode: "winner_evidence_insufficient",
    });
    expect(relative.classification.assessment).toMatchObject({
      value: "above_target_not_scale_ready",
      blockerCode: "account_baseline_not_economic",
    });
    expect(
      items.some(
        (item) => item.classification.assessment.value === "proven_winner",
      ),
    ).toBe(false);
  });

  it("scopes every source read through the explicit provider account", async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("scoped_history")) return [snapshot("creative_1")];
      if (sql.includes("COALESCE(creative_dim.provider_account_id")) {
        return [identity("creative_1")];
      }
      if (sql.includes("FROM meta_campaign_labels")) {
        return [
          {
            campaign_id: "cmp_1",
            label_kind: "main",
            label_source: "user",
            label_updated_at: "2026-07-09T10:00:00.000Z",
            inferred_kind: null,
            confidence_class: null,
            context_updated_at: null,
            resolver_version: null,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      generatedAt: "2026-07-10T12:00:00.000Z",
    });

    expect(model.status).toBe("available");
    expect(model.scope.providerAccountId).toBe("act_1");
    const snapshotCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("scoped_history"),
    );
    const identityCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("COALESCE(creative_dim.provider_account_id"),
    );
    const contextCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("FROM meta_campaign_labels"),
    );
    expect(String(snapshotCall?.[0])).toContain("provider_account_id = $2");
    expect(snapshotCall?.[1]).toEqual(["biz_1", "act_1"]);
    expect(String(identityCall?.[0])).toContain("provider_account_id = $2");
    expect(identityCall?.[1]).toEqual([
      "biz_1",
      "act_1",
      ["creative_1"],
      "2026-07-10",
    ]);
    expect(String(contextCall?.[0])).toContain("provider_account_id = $2");
    expect(contextCall?.[1]).toEqual([
      "biz_1",
      "act_1",
      ["cmp_1"],
      "2026-07-10",
    ]);
  });
});
