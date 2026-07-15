import { beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import * as db from "@/lib/db";
import {
  buildNativeMetaDecisionsWorkspaceReadModel,
  buildMetaDecisionsWorkspaceReadModel,
  buildUnavailableMetaDecisionsWorkspaceReadModel,
  reconcileMetaDecisionIdentityRowsWithCurrentAds,
  readMetaDecisionsWorkspaceReadModel,
  resolveProvisionalCampaignKind,
  type MetaDecisionCampaignContextSourceRow,
  type MetaDecisionIdentitySourceRow,
  type MetaDecisionSnapshotSourceRow,
  type MetaNativeDecisionGenerationSourceRow,
  type MetaNativeDecisionSnapshotSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/creative-decision-engine/campaign-context/source", () => ({
  resolveCampaignContextMode: vi.fn(() => "automatic"),
  isCampaignContextHardAuthorityEnabled: vi.fn(
    () =>
      process.env.CAMPAIGN_CONTEXT_HARD_AUTHORITY_ENABLED === "1" ||
      process.env.CAMPAIGN_CONTEXT_HARD_AUTHORITY_ENABLED === "true",
  ),
}));

describe("resolveProvisionalCampaignKind", () => {
  it("uses stored resolver scores without granting a trusted kind", () => {
    expect(
      resolveProvisionalCampaignKind({
        kind: null,
        signalScores: { mainScore: 0.17, testScore: 0.35, mixedScore: 0 },
      }),
    ).toBe("test");
    expect(
      resolveProvisionalCampaignKind({
        kind: null,
        signalScores: { mainScore: 0.53, testScore: 0.17, mixedScore: 0 },
      }),
    ).toBe("main");
  });

  it("keeps a persisted automatic or override kind unchanged", () => {
    expect(
      resolveProvisionalCampaignKind({
        kind: "mixed",
        signalScores: { mainScore: 1, testScore: 0, mixedScore: 0 },
      }),
    ).toBe("mixed");
  });

  it("uses the resolver name vocabulary before the role-neutral fallback", () => {
    expect(
      resolveProvisionalCampaignKind({
        kind: null,
        signalScores: null,
        campaignName: "R3 US Test",
      }),
    ).toBe("test");
    expect(
      resolveProvisionalCampaignKind({
        kind: null,
        signalScores: null,
        campaignName: "R3 US Winners",
      }),
    ).toBe("main");
    expect(
      resolveProvisionalCampaignKind({
        kind: null,
        signalScores: null,
        campaignName: "Unclassified current campaign",
      }),
    ).toBe("main");
  });
});

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
    pre_authority_label: null,
    authority_blocker: null,
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
    campaign_status: "ACTIVE",
    adset_status: "ACTIVE",
    ad_status: "ACTIVE",
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

function nativeSnapshot(
  adId: string,
  overrides: Partial<MetaNativeDecisionSnapshotSourceRow> = {},
): MetaNativeDecisionSnapshotSourceRow {
  return {
    snapshot_id: `00000000-0000-4000-8000-${adId.slice(-12).padStart(12, "0")}`,
    evaluation_id: `10000000-0000-4000-8000-${adId.slice(-12).padStart(12, "0")}`,
    job_run_id: "20000000-0000-4000-8000-000000000001",
    provider_account_ref_id: "30000000-0000-4000-8000-000000000001",
    provider_account_id: "act_1",
    ad_id: adId,
    creative_id: "creative_shared",
    as_of_date: "2026-07-12",
    engine_version: NATIVE_AD_ENGINE_VERSION,
    scope_type: "account",
    scope_id: "act_1",
    label: "cut",
    pre_authority_label: null,
    authority_blocker: null,
    raw_label: "cut",
    confidence: 88,
    truth_source: "commercial_truth",
    effective_target_roas: 2,
    ratio_to_target: 0.5,
    badges: [],
    reason: "Exact Ad evidence is below the account target.",
    spend: 120,
    purchases: 1,
    roas: 1,
    recent7d_roas: 0.9,
    label_transform: null,
    blocked_action_type: null,
    authorized_action: "cut",
    input_hash: "a".repeat(64),
    decision_hash: "b".repeat(64),
    computed_at: "2026-07-12T05:00:00.000Z",
    episode_started_at: "2026-07-12",
    lineage_valid: true,
    creative_name: "Shared creative",
    campaign_id: "cmp_1",
    campaign_name: "Main Sales",
    adset_id: "adset_1",
    adset_name: "Broad",
    ad_name: `Ad ${adId}`,
    campaign_status: "ACTIVE",
    adset_status: "ACTIVE",
    ad_status: "ACTIVE",
    currency: "USD",
    thumbnail_url: "https://cdn.example/shared.jpg",
    media_source_present: true,
    media_available: true,
    media_source: "meta_creative_media",
    source_updated_at: "2026-07-12T04:00:00.000Z",
    ...overrides,
  };
}

function nativeModel(rows: MetaNativeDecisionSnapshotSourceRow[]) {
  const adIds = rows.map((row) => row.ad_id);
  return buildNativeMetaDecisionsWorkspaceReadModel({
    businessId: "biz_1",
    providerAccountId: "act_1",
    generation: {
      jobRunId: "20000000-0000-4000-8000-000000000001",
      asOfDate: "2026-07-12",
      providerAccountRefId: "30000000-0000-4000-8000-000000000001",
      manifestHash: hashAdDecisionIdentityManifest({
        businessId: "biz_1",
        providerAccountId: "act_1",
        asOfDate: "2026-07-12",
        adIds,
      }),
      expectedAdCount: rows.length,
    },
    snapshotRows: rows,
    campaignContextRows: [context()],
    eventSourceAvailable: false,
    outcomeSourceAvailable: false,
    responseSourceAvailable: false,
    generatedAt: "2026-07-12T12:00:00.000Z",
  });
}

function nativeGeneration(
  row: MetaNativeDecisionSnapshotSourceRow,
  overrides: Partial<MetaNativeDecisionGenerationSourceRow> = {},
): MetaNativeDecisionGenerationSourceRow {
  const manifestHash = hashAdDecisionIdentityManifest({
    businessId: "biz_1",
    providerAccountId: row.provider_account_id,
    asOfDate: row.as_of_date,
    adIds: [row.ad_id],
  });
  return {
    job_status: "success",
    job_run_id: row.job_run_id,
    as_of_date: row.as_of_date,
    engine_version: NATIVE_AD_ENGINE_VERSION,
    provider_account_ref_id: row.provider_account_ref_id,
    provider_account_id: row.provider_account_id,
    expected_ad_count: 1,
    expected_manifest_hash: manifestHash,
    hydrated_ad_count: 1,
    hydrated_manifest_hash: manifestHash,
    authoritative_for_prune: true,
    ...overrides,
  };
}

function workspaceReadQuery(input: {
  generationRows?: unknown[];
  nativeRows?: MetaNativeDecisionSnapshotSourceRow[];
  legacyRows?: MetaDecisionSnapshotSourceRow[];
}) {
  return vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("WITH candidate_runs AS")) {
      return input.generationRows ?? [];
    }
    if (sql.includes("FROM engine_v3_ad_decision_snapshots_daily snapshot")) {
      return input.nativeRows ?? [];
    }
    if (sql.includes("scoped_history")) {
      return input.legacyRows ?? [snapshot("creative_1")];
    }
    if (sql.includes("COALESCE(creative_dim.provider_account_id")) {
      return [identity("creative_1")];
    }
    return [];
  });
}

describe("Meta Decisions workspace canonical read model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("holds inferred high campaign context below hard authority until its independent gate opens", () => {
    const input = {
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [snapshot("creative_1", { label: "scale" })],
      identityRows: [identity("creative_1")],
      campaignContextRows: [
        context({
          source: "system_inferred",
          confidenceClass: "high",
          resolverVersion: "campaign-context.v1",
        }),
      ],
      generatedAt: "2026-07-10T12:00:00.000Z",
    };

    const held = buildMetaDecisionsWorkspaceReadModel(input);
    expect(
      held.queue.sections.creative_rotation.items[0]?.classification
        .lifecycleRole,
    ).toMatchObject({
      value: "main",
      confidence: "medium",
      trustedForAction: false,
      blockerCode: "campaign_context_low_confidence",
    });

    vi.stubEnv("CAMPAIGN_CONTEXT_HARD_AUTHORITY_ENABLED", "true");
    const enabled = buildMetaDecisionsWorkspaceReadModel(input);
    expect(
      enabled.queue.sections.creative_rotation.items[0]?.classification
        .lifecycleRole,
    ).toMatchObject({
      value: "main",
      confidence: "high",
      trustedForAction: true,
      blockerCode: null,
    });
  });

  it("keeps two Ads that share one creative as independent native decisions", () => {
    const firstAdId = "120000000000000001";
    const secondAdId = "120000000000000002";
    const model = nativeModel([
      nativeSnapshot(firstAdId),
      nativeSnapshot(secondAdId, {
        adset_id: "adset_2",
        adset_name: "Retargeting",
      }),
    ]);

    expect(model.source).toMatchObject({
      authority: "native_ad",
      table: "engine_v3_ad_decision_snapshots_daily",
      generation: { expectedAdCount: 2 },
    });
    expect(model.queue.deduplicationGrain).toBe("ad");
    expect(
      model.queue.adCandidates?.items
        .map((item) => item.parentChain.ad?.id)
        .sort(),
    ).toEqual([firstAdId, secondAdId]);
    expect(
      model.queue.adCandidates?.items.map((item) => item.decisionId),
    ).toEqual(expect.arrayContaining([expect.any(String), expect.any(String)]));
    expect(
      new Set(model.queue.adCandidates?.items.map((item) => item.decisionId))
        .size,
    ).toBe(2);
    expect(
      model.queue.adCandidates?.items.every(
        (item) => item.identityResolution?.basis === "native_ad_exact",
      ),
    ).toBe(true);
  });

  it("keeps a native Ad authoritative when creative grouping is null", () => {
    const model = nativeModel([
      nativeSnapshot("120000000000000003", {
        creative_id: null,
        creative_name: null,
        thumbnail_url: null,
        media_source_present: false,
        media_available: false,
        media_source: null,
      }),
    ]);
    const decision = model.queue.adCandidates?.items[0]!;

    expect(decision.identityGrain).toBe("ad");
    expect(decision.parentChain.ad?.id).toBe("120000000000000003");
    expect(decision.parentChain.creative).toBeNull();
    expect(decision.sourceAuthority).toMatchObject({
      status: "native_exact",
      actionEligible: true,
      realAdId: "120000000000000003",
      authorizedAction: "cut",
    });
  });

  it("keeps closed hierarchy Ads out of the main queue and advisory-only", () => {
    const activeAdId = "120000000000000007";
    const pausedAdId = "120000000000000008";
    const model = nativeModel([
      nativeSnapshot(activeAdId),
      nativeSnapshot(pausedAdId, { adset_status: "PAUSED" }),
    ]);

    expect(
      model.queue.adCandidates?.items.map(
        (decision) => decision.parentChain.ad?.id,
      ),
    ).toEqual([activeAdId]);
    expect(model.queue.inactiveAssets).toMatchObject({
      preCapCount: 1,
      inactiveCount: 1,
      unknownCount: 0,
    });
    expect(model.queue.inactiveAssets?.items[0]).toMatchObject({
      parentChain: { ad: { id: pausedAdId } },
      deliveryScope: {
        state: "inactive",
        adsetStatus: "PAUSED",
      },
      sourceAuthority: {
        status: "native_exact",
        actionEligible: false,
        reviewOnlyReason: "current_hierarchy_is_not_active",
      },
    });
  });

  it("defaults missing hierarchy truth to the advisory-only inactive queue", () => {
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [snapshot("creative_unknown")],
      identityRows: [
        identity("creative_unknown", {
          campaign_status: null,
          adset_status: "ACTIVE",
          ad_status: "ACTIVE",
        }),
      ],
      campaignContextRows: [context()],
      generatedAt: "2026-07-10T12:00:00.000Z",
    });

    expect(model.queue.adCandidates?.items).toHaveLength(0);
    expect(model.queue.inactiveAssets).toMatchObject({
      preCapCount: 1,
      inactiveCount: 0,
      unknownCount: 1,
    });
    expect(model.queue.inactiveAssets?.items[0]).toMatchObject({
      deliveryScope: { state: "unknown" },
      sourceAuthority: {
        actionEligible: false,
        reviewOnlyReason: "current_hierarchy_status_is_unknown",
      },
    });
  });

  it("rejects broken native lineage and cross-account rows", () => {
    expect(() =>
      nativeModel([
        nativeSnapshot("120000000000000004", { lineage_valid: false }),
      ]),
    ).toThrow(/lineage or manifest is incomplete/i);
    expect(() =>
      nativeModel([
        nativeSnapshot("120000000000000005", {
          provider_account_id: "act_other",
        }),
      ]),
    ).toThrow(/lineage or manifest is incomplete/i);
  });

  it("serves an authoritative native zero-Ad account as available, not missing", () => {
    const model = nativeModel([]);
    expect(model).toMatchObject({
      status: "available",
      unavailable: null,
      source: {
        authority: "native_ad",
        generation: { expectedAdCount: 0 },
      },
      queue: { deduplicationGrain: "ad", sourcePreCapCount: 0 },
    });
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

  it("does not expose a representative Ad for an ambiguous legacy creative", () => {
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [snapshot("creative_reused")],
      identityRows: [identity("creative_reused", { candidate_ad_count: 2 })],
      campaignContextRows: [context()],
    });
    const decision = model.queue.sections.creative_rotation.items[0]!;

    expect(decision.parentChain.ad).toBeNull();
    expect(decision.identityResolution).toMatchObject({
      basis: "creative_ambiguous",
      adActionEligible: false,
    });
    expect(decision.sourceAuthority?.realAdId).toBeNull();
    expect(model.queue.adCandidates?.items).toEqual([]);
  });

  it("keeps legacy creative compatibility visible but review-only", () => {
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [snapshot("creative_legacy", { label: "cut" })],
      identityRows: [identity("creative_legacy")],
      campaignContextRows: [context()],
    });
    const decision = model.queue.adCandidates?.items[0]!;

    expect(model.source.authority).toBe("legacy_creative");
    expect(decision.parentChain.ad?.id).toMatch(/^\d+$/);
    expect(decision.sourceAuthority).toMatchObject({
      status: "legacy_review_only",
      actionEligible: false,
      authorizedAction: null,
    });
  });

  it("uses a complete current Meta Ad receipt as delivery truth without changing identity ambiguity", () => {
    const reconciled = reconcileMetaDecisionIdentityRowsWithCurrentAds({
      identityRows: [
        identity("creative_active", {
          ad_id: "120000000000000001",
          candidate_ad_count: 1,
          campaign_status: null,
          adset_status: null,
          ad_status: null,
        }),
        identity("creative_paused", {
          ad_id: "120000000000000002",
          candidate_ad_count: 2,
        }),
        identity("creative_deleted", {
          ad_id: "120000000000000003",
          candidate_ad_count: 1,
        }),
      ],
      currentAds: [
        {
          providerAccountId: "act_1",
          adId: "120000000000000001",
          adName: "Current active Ad",
          campaignId: "cmp_1",
          adsetId: "adset_1",
          creativeId: "creative_active",
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          providerUpdatedAt: "2026-07-13T08:00:00.000Z",
          fetchedAt: "2026-07-13T09:00:00.000Z",
        },
        {
          providerAccountId: "act_1",
          adId: "120000000000000002",
          adName: "Paused by campaign",
          campaignId: "cmp_1",
          adsetId: "adset_1",
          creativeId: "creative_paused",
          configuredStatus: "ACTIVE",
          effectiveStatus: "CAMPAIGN_PAUSED",
          providerUpdatedAt: null,
          fetchedAt: "2026-07-13T09:00:00.000Z",
        },
      ],
      sourceComplete: true,
    });

    expect(reconciled[0]).toMatchObject({
      ad_name: "Current active Ad",
      campaign_status: "ACTIVE",
      adset_status: "ACTIVE",
      ad_status: "ACTIVE",
      candidate_ad_count: 1,
      status_source: "meta_graph_ad_configs",
    });
    expect(reconciled[1]).toMatchObject({
      campaign_status: "CAMPAIGN_PAUSED",
      adset_status: "CAMPAIGN_PAUSED",
      ad_status: "CAMPAIGN_PAUSED",
      candidate_ad_count: 2,
    });
    expect(reconciled[2]).toMatchObject({
      campaign_status: "NOT_ACTIVE",
      adset_status: "NOT_ACTIVE",
      ad_status: "NOT_ACTIVE",
    });
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
        (item) => item.parentChain.creative?.id === "urgent_cut",
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
    ).toEqual(first.queue.adCandidates?.items.map((item) => item.decisionId));
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

  it("never presents a soft-published held Cut as Continue Test", () => {
    const model = nativeModel([
      nativeSnapshot("120000000000000078", {
        label: "test_more",
        pre_authority_label: "cut",
        authority_blocker: "profile_hard_action_ineligible",
        raw_label: "test_more",
        blocked_action_type: "cut",
        authorized_action: null,
        badges: [
          {
            type: "cut_candidate",
            label: "Soft-cut candidate",
            severity: "warning",
          },
          {
            type: "campaign_context_unresolved",
            label: "Campaign context unresolved",
            severity: "warning",
          },
        ],
        reason:
          "[soft-only - cut blocked] Clear loser at scale (native_ad_calibration:pooled_optimization_context_soft_only)",
      }),
    ]);
    const item = model.queue.adCandidates?.items[0];

    expect(item?.classification).toMatchObject({
      decisionState: "blocked",
      heldAction: "cut",
      legacyBuyerAction: "test_more",
      buyerAction: null,
      buyerLabel: "Cut · Held",
      executionAction: null,
      assessment: { value: "below_target" },
      resolution: {
        code: "complete_hard_action_evidence",
        label: "Complete Hard-Action Evidence",
      },
    });
    expect(item?.classification.buyerLabel).not.toMatch(/continue test/i);
    expect(item?.sourceAuthority).toMatchObject({
      status: "native_exact",
      actionEligible: false,
      authorizedAction: null,
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
      (item) => item.parentChain.creative?.id === "stable_keep",
    );
    const notApplicable = items.find(
      (item) => item.parentChain.creative?.id === "not_applicable",
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
    const thin = items.find(
      (item) => item.parentChain.creative?.id === "thin",
    )!;
    const relative = items.find(
      (item) => item.parentChain.creative?.id === "relative",
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
    expect(snapshotCall?.[1]).toEqual(["biz_1", "act_1", null]);
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

  it("falls back cleanly when the optional entity-state table is not migrated", async () => {
    const undefinedRelation = Object.assign(
      new Error('relation "meta_entity_state_history" does not exist'),
      { code: "42P01" },
    );
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("WITH candidate_runs AS")) return [];
      if (sql.includes("scoped_history")) return [snapshot("creative_1")];
      if (sql.includes("FROM meta_entity_state_history state")) {
        throw undefinedRelation;
      }
      if (sql.includes("NULL::text AS campaign_status")) {
        return [
          identity("creative_1", {
            campaign_status: null,
            adset_status: null,
            ad_status: null,
          }),
        ];
      }
      if (sql.includes("FROM meta_campaign_labels")) return [];
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      currentAdSourceComplete: true,
      currentAds: [
        {
          providerAccountId: "act_1",
          adId: identity("creative_1").ad_id!,
          adName: "Current active Ad",
          campaignId: "cmp_1",
          adsetId: "adset_1",
          creativeId: "creative_1",
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          providerUpdatedAt: "2026-07-13T08:00:00.000Z",
          fetchedAt: "2026-07-13T09:00:00.000Z",
        },
      ],
    });

    expect(model.status).toBe("available");
    expect(model.queue.adCandidates?.items).toHaveLength(1);
    expect(model.queue.adCandidates?.items[0]?.deliveryScope).toMatchObject({
      state: "active",
      campaignStatus: "ACTIVE",
      adsetStatus: "ACTIVE",
      adStatus: "ACTIVE",
      provenance: { source: "meta_graph_ad_configs" },
    });
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("NULL::text AS campaign_status"),
      ),
    ).toBe(true);
    const generationCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("WITH candidate_runs AS"),
    );
    expect(String(generationCall?.[0])).toContain(
      "run.business_id = $1::text",
    );
  });

  it("falls back to visible legacy rows when the latest native account manifest is incomplete", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("WITH candidate_runs AS")) {
        return [
          {
            job_status: "success",
            job_run_id: "native-run",
            as_of_date: "2026-07-12",
            engine_version: NATIVE_AD_ENGINE_VERSION,
            provider_account_ref_id: "30000000-0000-4000-8000-000000000001",
            provider_account_id: "act_1",
            expected_ad_count: 2,
            expected_manifest_hash: "a".repeat(64),
            hydrated_ad_count: 1,
            hydrated_manifest_hash: "b".repeat(64),
            authoritative_for_prune: false,
          },
        ];
      }
      if (sql.includes("scoped_history")) return [snapshot("creative_1")];
      if (sql.includes("COALESCE(creative_dim.provider_account_id")) {
        return [identity("creative_1")];
      }
      if (sql.includes("FROM meta_campaign_labels")) return [];
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });

    expect(model.status).toBe("available");
    expect(model.source).toMatchObject({
      authority: "legacy_creative",
      fallbackReason: "native_account_manifest_incomplete",
    });
    expect(model.queue.adCandidates?.items).toHaveLength(1);
    expect(
      model.queue.adCandidates?.items[0]?.sourceAuthority?.actionEligible,
    ).toBe(false);
  });

  it.each([
    ["failed", "native_latest_job_failed"],
    ["skipped", "native_latest_job_skipped"],
  ] as const)(
    "fails closed when the newest effective terminal native run is %s",
    async (jobStatus, fallbackReason) => {
      const row = nativeSnapshot("120000000000000021");
      const query = workspaceReadQuery({
        generationRows: [
          nativeGeneration(row, {
            job_status: jobStatus,
            job_run_id: `newer-${jobStatus}`,
          }),
        ],
      });
      vi.mocked(db.getDb).mockReturnValue({ query } as never);

      const model = await readMetaDecisionsWorkspaceReadModel({
        businessId: "biz_1",
        providerAccountId: "act_1",
      });
      const generationCall = query.mock.calls.find(([sql]) =>
        sql.includes("WITH candidate_runs AS"),
      );

      expect(model.source).toMatchObject({
        authority: "legacy_creative",
        fallbackReason,
      });
      expect(
        query.mock.calls.some(([sql]) =>
          sql.includes("FROM engine_v3_ad_decision_snapshots_daily snapshot"),
        ),
      ).toBe(false);
      expect(String(generationCall?.[0])).toContain(
        "WHERE run.effective_status <> 'running'",
      );
      expect(String(generationCall?.[0])).not.toContain(
        "AND run.status = 'success'",
      );
    },
  );

  it("fails closed when the newest successful generation belongs to another engine epoch", async () => {
    const row = nativeSnapshot("120000000000000023");
    const query = workspaceReadQuery({
      generationRows: [
        nativeGeneration(row, {
          engine_version: "v3-prior-native-epoch",
        }),
      ],
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });
    const generationCall = query.mock.calls.find(([sql]) =>
      sql.includes("WITH candidate_runs AS"),
    );

    expect(model.source).toMatchObject({
      authority: "legacy_creative",
      fallbackReason: "native_latest_job_engine_mismatch",
    });
    expect(String(generationCall?.[0])).not.toContain(
      "run.engine_version =",
    );
    expect(generationCall?.[1]).toEqual([
      "biz_1",
      "act_1",
      expect.any(String),
      null,
      expect.any(Number),
    ]);
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes("FROM engine_v3_ad_decision_snapshots_daily snapshot"),
      ),
    ).toBe(false);
  });

  it("serves a later recovery success after a failed native generation", async () => {
    const row = nativeSnapshot("120000000000000022", {
      job_run_id: "20000000-0000-4000-8000-000000000022",
    });
    const query = workspaceReadQuery({
      generationRows: [nativeGeneration(row)],
      nativeRows: [row],
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });

    expect(model.source).toMatchObject({
      authority: "native_ad",
      generation: { jobRunId: row.job_run_id },
    });
    expect(model.queue.adCandidates?.items[0]?.sourceAuthority).toMatchObject({
      status: "native_exact",
      jobRunId: row.job_run_id,
    });
  });

  it("enforces the requested as-of bound on native and legacy reads", async () => {
    const query = workspaceReadQuery({ generationRows: [] });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      asOfDate: "2026-07-10",
    });
    const generationCall = query.mock.calls.find(([sql]) =>
      sql.includes("WITH candidate_runs AS"),
    );
    const legacyCall = query.mock.calls.find(([sql]) =>
      sql.includes("scoped_history"),
    );

    expect(String(generationCall?.[0])).toContain(
      "run.as_of_date <= COALESCE(\n          $4::date",
    );
    expect(generationCall?.[1]).toEqual([
      "biz_1",
      "act_1",
      "engine_v3_native_ad_decisions_shadow_job",
      "2026-07-10",
      120_000,
    ]);
    expect(String(legacyCall?.[0])).toContain(
      "snapshot.as_of_date <= COALESCE(\n          $3::date",
    );
    expect(legacyCall?.[1]).toEqual(["biz_1", "act_1", "2026-07-10"]);
  });

  it("ignores an advisory-lock skip only with the scheduler overlap proof", async () => {
    const row = nativeSnapshot("120000000000000023", {
      job_run_id: "20000000-0000-4000-8000-000000000023",
    });
    const query = workspaceReadQuery({
      generationRows: [nativeGeneration(row)],
      nativeRows: [row],
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });
    const generationSql = String(
      query.mock.calls.find(([sql]) =>
        sql.includes("WITH candidate_runs AS"),
      )?.[0],
    );

    expect(model.source.authority).toBe("native_ad");
    expect(generationSql).toContain("run.status = 'skipped'");
    expect(generationSql).toContain(
      "COALESCE(run.error_message, '') ILIKE 'Advisory lock not acquired%'",
    );
    expect(generationSql).toContain("holder.as_of_date = run.as_of_date");
    expect(generationSql).toContain(
      "holder.started_at <= COALESCE(run.finished_at, run.started_at)",
    );
    expect(generationSql).toContain("holder.finished_at >= run.started_at");
    expect(generationSql).toContain(
      "holder.finished_at <= statement_timestamp()",
    );
  });

  it("keeps the last valid success visible during a fresh running attempt", async () => {
    const row = nativeSnapshot("120000000000000024", {
      job_run_id: "20000000-0000-4000-8000-000000000024",
    });
    const query = workspaceReadQuery({
      generationRows: [nativeGeneration(row)],
      nativeRows: [row],
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });
    const generationSql = String(
      query.mock.calls.find(([sql]) =>
        sql.includes("WITH candidate_runs AS"),
      )?.[0],
    );

    expect(model.source).toMatchObject({
      authority: "native_ad",
      generation: { jobRunId: row.job_run_id },
    });
    expect(generationSql).toContain(
      "WHEN run.status = 'running'",
    );
    expect(generationSql).toContain(
      "make_interval(secs => $5::double precision / 1000.0)",
    );
    expect(generationSql).toContain(
      "THEN 'failed'",
    );
    expect(generationSql).toContain(
      "WHEN run.finished_at IS NULL\n            OR run.finished_at > statement_timestamp()\n          THEN 'failed'",
    );
    expect(generationSql).toContain(
      "WHERE run.effective_status <> 'running'",
    );
  });

  it("reads native identity by exact Ad id without choosing a representative Ad", async () => {
    const row = nativeSnapshot("120000000000000006");
    const manifestHash = hashAdDecisionIdentityManifest({
      businessId: "biz_1",
      providerAccountId: "act_1",
      asOfDate: "2026-07-12",
      adIds: [row.ad_id],
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("WITH candidate_runs AS")) {
        return [
          {
            job_status: "success",
            job_run_id: row.job_run_id,
            as_of_date: row.as_of_date,
            engine_version: NATIVE_AD_ENGINE_VERSION,
            provider_account_ref_id: row.provider_account_ref_id,
            provider_account_id: row.provider_account_id,
            expected_ad_count: 1,
            expected_manifest_hash: manifestHash,
            hydrated_ad_count: 1,
            hydrated_manifest_hash: manifestHash,
            authoritative_for_prune: true,
          },
        ];
      }
      if (sql.includes("FROM engine_v3_ad_decision_snapshots_daily snapshot")) {
        return [row];
      }
      if (sql.includes("FROM meta_campaign_labels")) return [];
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });
    const nativeSnapshotCall = query.mock.calls.find(([sql]) =>
      String(sql).includes(
        "FROM engine_v3_ad_decision_snapshots_daily snapshot",
      ),
    );

    expect(model.source.authority).toBe("native_ad");
    expect(model.queue.adCandidates?.items[0]?.parentChain.ad?.id).toBe(
      row.ad_id,
    );
    expect(String(nativeSnapshotCall?.[0])).toContain(
      "dimension.ad_id = snapshot.ad_id",
    );
    expect(String(nativeSnapshotCall?.[0])).toContain(
      "snapshot.pre_authority_label",
    );
    expect(String(nativeSnapshotCall?.[0])).toContain(
      "snapshot.authority_blocker",
    );
    expect(String(nativeSnapshotCall?.[0])).not.toContain(
      "creative_id = requested.creative_id",
    );
  });

  it("maps persisted authority provenance from legacy and native snapshots without inferring historical nulls", () => {
    const legacy = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [
        snapshot("creative_legacy", {
          label: "keep",
          raw_label: "keep",
          pre_authority_label: "scale",
          authority_blocker: "source_freshness",
        }),
      ],
      identityRows: [identity("creative_legacy")],
      campaignContextRows: [context()],
    });
    const legacyDecision =
      legacy.queue.sections.creative_rotation.items[0] ??
      legacy.queue.adCandidates?.items[0];

    expect(legacy.contractVersion).toBe("meta-decisions-workspace.read.v3");
    expect(legacyDecision?.sourceDecision).toMatchObject({
      label: "keep",
      rawLabel: "keep",
      preAuthorityLabel: "scale",
      authorityBlocker: "source_freshness",
    });

    const native = nativeModel([
      nativeSnapshot("120000000000000077", {
        label: "keep",
        raw_label: "keep",
        pre_authority_label: "cut",
        authority_blocker: "profile_hard_action_ineligible",
        blocked_action_type: "cut",
        authorized_action: null,
      }),
    ]);
    expect(native.queue.adCandidates?.items[0]?.sourceDecision).toMatchObject({
      label: "keep",
      rawLabel: "keep",
      preAuthorityLabel: "cut",
      authorityBlocker: "profile_hard_action_ineligible",
    });

    const historical = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [snapshot("creative_historical")],
      identityRows: [identity("creative_historical")],
      campaignContextRows: [context()],
    });
    expect(
      historical.queue.sections.creative_rotation.items[0]?.sourceDecision,
    ).toMatchObject({
      preAuthorityLabel: null,
      authorityBlocker: null,
    });
  });
});
