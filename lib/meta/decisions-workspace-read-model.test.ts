import { beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import * as db from "@/lib/db";
import {
  NATIVE_DECISION_LAST_SUCCESS_MAX_AGE_DAYS,
  READ_NATIVE_DECISION_GENERATION_QUERY,
  buildNativeMetaCanonicalDecisionInventory,
  buildNativeMetaDecisionsWorkspaceReadModel,
  applyMetaExecutionGovernanceToCanonicalDecisions,
  applyMetaExecutionGovernanceToReadModel,
  buildMetaDecisionsWorkspaceReadModel,
  buildUnavailableMetaDecisionsWorkspaceReadModel,
  reconcileMetaDecisionIdentityRowsWithCurrentAds,
  readMetaDecisionCampaignContextRows,
  readMetaDecisionsWorkspaceReadModel,
  readMetaNativeCanonicalDecisionInventory,
  readValidatedMetaNativeDecisionGenerationBundle,
  resolveProvisionalCampaignKind,
  validateMetaNativeDecisionGenerationBundle,
  type MetaDecisionCampaignContextSourceRow,
  type MetaDecisionIdentitySourceRow,
  type MetaDecisionSnapshotSourceRow,
  type MetaNativeDecisionGenerationSourceRow,
  type MetaNativeDecisionSnapshotSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import { projectMetaDecisionSemantics } from "@/lib/meta/decision-semantics";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { projectCanonicalNativeAdDecisionToBriefing } from "@/app/api/creatives/briefing/canonical-projection";
import { buildMetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-presentation";
import {
  buildMetaDecisionPipelineHealth,
  META_DECISION_PIPELINE_HEALTH_CONTRACT_VERSION,
  META_DECISION_SYNC_ACTIVITY_MAX_AGE_MINUTES,
  type MetaDecisionPipelineOperationalHealth,
} from "@/lib/meta/decision-pipeline-health";
import { isCampaignContextResolverAuthorityValidated } from "@/lib/creative-decision-engine/campaign-context/source";

vi.mock("@/lib/db", () => {
  const getDb = vi.fn();
  return {
    getDb,
    getDbWithTimeout: vi.fn(() => getDb()),
  };
});

vi.mock("@/lib/creative-decision-engine/campaign-context/source", () => ({
  resolveCampaignContextMode: vi.fn(() => "automatic"),
  isCampaignContextResolverAuthorityValidated: vi.fn(() => true),
  CAMPAIGN_CONTEXT_MAX_AGE_DAYS: 2,
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

/**
 * D074/D076: the reader must EXPLAIN the resolver's own answer — score,
 * evidence, conflicts, unresolved reason, last evaluation time — verbatim from
 * the persisted row, and must say "not yet evaluated" for a campaign the
 * resolver has never seen rather than diagnosing it.
 */
describe("readMetaDecisionCampaignContextRows explanation fields", () => {
  const readContextRows = (dbRows: Record<string, unknown>[]) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM engine_v3_campaign_context_daily")) return dbRows;
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);
    return readMetaDecisionCampaignContextRows({
      businessId: "biz_1",
      providerAccountId: "act_1",
      campaignIds: dbRows.map((row) => String(row.campaign_id)),
      snapshotAsOf: "2026-07-10",
    });
  };

  it("carries the resolver's explanation verbatim for a resolved campaign", async () => {
    const [row] = await readContextRows([
      {
        campaign_id: "cmp_1",
        inferred_kind: "main",
        confidence_class: "high",
        confidence_score: "0.87",
        signal_scores_json: { mainScore: 0.87 },
        evidence_json: ["budget concentration 0.81", "purchase volume stable"],
        conflict_reasons_json: [],
        context_updated_at: "2026-07-09T10:00:00.000Z",
        context_as_of_date: "2026-07-09",
        resolver_version: "campaign-context-v2-account-scoped",
      },
    ]);
    expect(row).toMatchObject({
      campaignId: "cmp_1",
      kind: "main",
      confidenceClass: "high",
      confidenceScore: 0.87,
      evidence: ["budget concentration 0.81", "purchase volume stable"],
      conflictReasons: [],
      unresolvedReason: null,
      lastEvaluatedAt: "2026-07-09T10:00:00.000Z",
      resolverVersion: "campaign-context-v2-account-scoped",
    });
  });

  it("derives the unresolved reason from the persisted confidence class", async () => {
    const rows = await readContextRows([
      {
        campaign_id: "cmp_insufficient",
        inferred_kind: null,
        confidence_class: "unknown",
        confidence_score: null,
        signal_scores_json: null,
        evidence_json: [],
        conflict_reasons_json: [],
        context_updated_at: "2026-07-09T10:00:00.000Z",
        context_as_of_date: "2026-07-09",
        resolver_version: "campaign-context-v2-account-scoped",
      },
      {
        campaign_id: "cmp_conflict",
        inferred_kind: null,
        confidence_class: "conflict",
        confidence_score: 0.4,
        signal_scores_json: null,
        evidence_json: [],
        conflict_reasons_json: ["name says test, budget says main"],
        context_updated_at: null,
        context_as_of_date: "2026-07-09",
        resolver_version: "campaign-context-v2-account-scoped",
      },
    ]);
    expect(rows[0]).toMatchObject({
      kind: null,
      unresolvedReason: "insufficient_evidence",
    });
    expect(rows[1]).toMatchObject({
      kind: null,
      unresolvedReason: "conflicting_signals",
      conflictReasons: ["name says test, budget says main"],
      // updated_at is absent, so the row's own as_of_date stands in.
      lastEvaluatedAt: "2026-07-09T00:00:00.000Z",
    });
  });

  it("reads a campaign with no context row as not yet evaluated", async () => {
    // The LEFT JOIN emits one all-null row per requested campaign id.
    const [row] = await readContextRows([
      {
        campaign_id: "cmp_never_seen",
        inferred_kind: null,
        confidence_class: null,
        confidence_score: null,
        signal_scores_json: null,
        evidence_json: null,
        conflict_reasons_json: null,
        context_updated_at: null,
        context_as_of_date: null,
        resolver_version: null,
      },
    ]);
    expect(row).toMatchObject({
      kind: null,
      confidenceScore: null,
      evidence: [],
      conflictReasons: [],
      unresolvedReason: "not_yet_evaluated",
      lastEvaluatedAt: null,
      resolverVersion: null,
    });
  });

  it("reads malformed jsonb as empty arrays rather than throwing", async () => {
    const [row] = await readContextRows([
      {
        campaign_id: "cmp_malformed",
        inferred_kind: "test",
        confidence_class: "medium",
        confidence_score: "not-a-number",
        signal_scores_json: null,
        evidence_json: "{not json at all",
        conflict_reasons_json: { object: "not an array" },
        context_updated_at: "2026-07-09T10:00:00.000Z",
        context_as_of_date: "2026-07-09",
        resolver_version: "campaign-context-v2-account-scoped",
      },
    ]);
    expect(row).toMatchObject({
      kind: "test",
      confidenceScore: null,
      evidence: [],
      conflictReasons: [],
      unresolvedReason: null,
    });
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

/**
 * The body of one named CTE of the generation query, so an assertion can say
 * WHICH selection a predicate belongs to.
 *
 * A substring test over the whole statement cannot tell "the latest run is
 * ranked across engine epochs" from "the last-success candidate is not", and
 * those are opposite requirements that live in the same string. The scan is
 * depth-aware because the candidate CTE contains a parenthesised EXISTS
 * subquery, so the first `)` is not the end of the body.
 */
function cteBody(sql: string, name: string): string {
  const opened = sql.indexOf(`${name} AS (`);
  if (opened < 0) throw new Error(`No CTE named ${name} in the query.`);
  let depth = 0;
  for (let index = opened + name.length + 3; index < sql.length; index += 1) {
    if (sql[index] === "(") depth += 1;
    else if (sql[index] === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(opened, index + 1);
    }
  }
  throw new Error(`CTE ${name} is not closed.`);
}

function context(
  overrides: Partial<MetaDecisionCampaignContextSourceRow> = {},
): MetaDecisionCampaignContextSourceRow {
  return {
    campaignId: "cmp_1",
    kind: "main",
    source: "system_inferred",
    confidenceClass: "high",
    sourceUpdatedAt: "2026-07-09T10:00:00.000Z",
    resolverVersion: "campaign-context-v2-account-scoped",
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

function nativeModel(
  rows: MetaNativeDecisionSnapshotSourceRow[],
  options: {
    adCandidateLimit?: number;
    campaignContextRows?: MetaDecisionCampaignContextSourceRow[];
  } = {},
) {
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
    campaignContextRows: options.campaignContextRows ?? [context()],
    eventSourceAvailable: false,
    outcomeSourceAvailable: false,
    responseSourceAvailable: false,
    generatedAt: "2026-07-12T12:00:00.000Z",
    adCandidateLimit: options.adCandidateLimit,
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
    selection: "latest",
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

function nativeGenerationForRows(
  rows: readonly MetaNativeDecisionSnapshotSourceRow[],
  overrides: Partial<MetaNativeDecisionGenerationSourceRow> = {},
): MetaNativeDecisionGenerationSourceRow {
  const first = rows[0]!;
  const manifestHash = hashAdDecisionIdentityManifest({
    businessId: "biz_1",
    providerAccountId: first.provider_account_id,
    asOfDate: first.as_of_date,
    adIds: rows.map((row) => row.ad_id),
  });
  return {
    selection: "latest",
    job_status: "success",
    job_run_id: first.job_run_id,
    as_of_date: first.as_of_date,
    engine_version: NATIVE_AD_ENGINE_VERSION,
    provider_account_ref_id: first.provider_account_ref_id,
    provider_account_id: first.provider_account_id,
    expected_ad_count: rows.length,
    expected_manifest_hash: manifestHash,
    hydrated_ad_count: rows.length,
    hydrated_manifest_hash: manifestHash,
    authoritative_for_prune: true,
    ...overrides,
  };
}

function nativeBuildGeneration(
  rows: readonly MetaNativeDecisionSnapshotSourceRow[],
) {
  const first = rows[0]!;
  return {
    jobRunId: first.job_run_id,
    asOfDate: first.as_of_date,
    providerAccountRefId: first.provider_account_ref_id,
    manifestHash: hashAdDecisionIdentityManifest({
      businessId: "biz_1",
      providerAccountId: first.provider_account_id,
      asOfDate: first.as_of_date,
      adIds: rows.map((row) => row.ad_id),
    }),
    expectedAdCount: rows.length,
  };
}

/**
 * A pipeline whose OPERATIONAL half is clean, so anything the health gate
 * refuses below comes from the decision generation and not from sync,
 * warehouse, or admission evidence.
 */
function healthyOperationalPipeline(): MetaDecisionPipelineOperationalHealth {
  return {
    contractVersion: META_DECISION_PIPELINE_HEALTH_CONTRACT_VERSION,
    evaluatedAt: "2026-07-12T12:00:00.000Z",
    overall: "healthy",
    executionReady: true,
    blockers: [],
    syncActivity: {
      status: "fresh",
      latestAt: "2026-07-12T11:50:00.000Z",
      ageMinutes: 10,
      maxAgeMinutes: META_DECISION_SYNC_ACTIVITY_MAX_AGE_MINUTES,
      latestJobStatus: "success",
      latestRunStatus: "success",
      reason: null,
    },
    warehouse: {
      status: "fresh",
      latestFinalizedDate: "2026-07-11",
      expectedFinalizedDate: "2026-07-11",
      lagDays: 0,
      accountTimeZone: "UTC",
      reason: null,
    },
    admission: {
      status: "fresh",
      allowed: true,
      reason: "within_budget",
      offender: null,
      evaluatedAt: "2026-07-12T12:00:00.000Z",
    },
  };
}

/**
 * A persisted automatic campaign-context row, in the DB shape
 * `readMetaDecisionCampaignContextRows` reads. Defaults resolve `cmp_1` as an
 * authoritative Main campaign, which is what makes a served `cut` verdict
 * action-eligible through the mocked read path instead of blocked on
 * unresolved context.
 */
function campaignContextDbRow(overrides: Record<string, unknown> = {}) {
  return {
    campaign_id: "cmp_1",
    inferred_kind: "main",
    confidence_class: "high",
    confidence_score: 0.92,
    signal_scores_json: null,
    evidence_json: null,
    conflict_reasons_json: null,
    context_updated_at: "2026-07-11T10:00:00.000Z",
    context_as_of_date: "2026-07-11",
    resolver_version: "campaign-context-v2-account-scoped",
    kind_source: "system_inferred",
    ...overrides,
  };
}

function workspaceReadQuery(input: {
  generationRows?: unknown[];
  nativeRows?: MetaNativeDecisionSnapshotSourceRow[];
  legacyRows?: MetaDecisionSnapshotSourceRow[];
  /** Defaults to none, which is what an unresolved campaign looks like. */
  campaignContextRows?: unknown[];
}) {
  return vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("WITH candidate_runs AS")) {
      return input.generationRows ?? [];
    }
    if (sql.includes("FROM engine_v3_campaign_context_daily")) {
      return input.campaignContextRows ?? [];
    }
    if (sql.includes("native-ad-serving-manifest")) {
      return (input.nativeRows ?? []).map((row) => ({ ad_id: row.ad_id }));
    }
    if (sql.includes("FROM engine_v3_ad_decision_snapshots_daily snapshot")) {
      const creativeIds = new Set((params?.[7] ?? []) as string[]);
      const adIds = new Set((params?.[9] ?? []) as string[]);
      return (input.nativeRows ?? []).filter(
        (row) =>
          (params?.[6] !== true || creativeIds.has(row.creative_id ?? "")) &&
          (params?.[8] !== true || adIds.has(row.ad_id)),
      );
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
    vi.mocked(isCampaignContextResolverAuthorityValidated).mockReturnValue(
      true,
    );
  });

  it("trusts only high-confidence automatic campaign context for hard-role semantics", () => {
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

    const model = buildMetaDecisionsWorkspaceReadModel(input);
    expect(
      model.queue.sections.creative_rotation.items[0]?.classification
        .lifecycleRole,
    ).toMatchObject({
      value: "main",
      confidence: "high",
      trustedForAction: true,
      blockerCode: null,
    });
  });

  it("keeps a high-confidence automatic role review-only until its resolver version is validated", () => {
    vi.mocked(isCampaignContextResolverAuthorityValidated).mockReturnValueOnce(
      false,
    );
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [snapshot("creative_1", { label: "scale" })],
      identityRows: [identity("creative_1")],
      campaignContextRows: [
        context({
          source: "system_inferred",
          confidenceClass: "high",
          resolverVersion: "campaign-context.unvalidated",
        }),
      ],
      generatedAt: "2026-07-10T12:00:00.000Z",
    });

    expect(
      model.queue.sections.creative_rotation.items[0]?.classification
        .lifecycleRole,
    ).toMatchObject({
      value: "main",
      confidence: "high",
      trustedForAction: false,
      blockerCode: "campaign_context_resolver_unvalidated",
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

  it("keeps a native Ad visible but review-only when creative identity is null", () => {
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
      actionEligible: false,
      reviewOnlyReason: "current_creative_identity_is_missing",
      realAdId: "120000000000000003",
      authorizedAction: null,
    });
    expect(decision.identityResolution).toMatchObject({
      basis: "native_ad_exact",
      adActionEligible: false,
    });
  });

  it("keeps action authority only when campaign, ad set, and ad are exactly ACTIVE", () => {
    const model = applyMetaExecutionGovernanceToReadModel({
      model: nativeModel([nativeSnapshot("120000000000000006")]),
    governance: {
      verified: true,
      controlsConfigured: true,
      writeBlocked: false,
      blockReason: null,
    },
    pipeline: { verified: true, executionReady: true },
    now: new Date("2026-07-12T12:00:00.000Z"),
    });
    const decision = model.queue.adCandidates?.items[0];

    expect(decision?.deliveryScope).toMatchObject({
      state: "active",
      campaignStatus: "ACTIVE",
      adsetStatus: "ACTIVE",
      adStatus: "ACTIVE",
    });
    expect(decision?.sourceAuthority).toMatchObject({
      actionEligible: true,
      reviewOnlyReason: null,
      authorizedAction: "cut",
    });
    expect(decision?.classification).toMatchObject({
      decisionState: "act",
      buyerAction: "cut",
      heldAction: null,
    });
    expect(
      projectCanonicalNativeAdDecisionToBriefing({ decision: decision! }),
    ).toMatchObject({
      lane: "action",
      card: {
        sourceDecisionActionEligible: true,
        sourceDecisionAuthorizedAction: "cut",
      },
    });
  });

  it("keeps persisted decision authority distinct from serve-time execution readiness", () => {
    const raw = nativeModel([nativeSnapshot("120000000000000016")]);
    expect(raw.queue.adCandidates?.items[0]?.sourceAuthority).toMatchObject({
      actionEligible: true,
      authorizedAction: "cut",
      executionReadiness: "governance_unavailable",
      decisionFreshness: { status: "fresh", ageHours: 7, maxAgeHours: 12 },
    });

    const ready = applyMetaExecutionGovernanceToReadModel({
      model: raw,
      governance: {
        verified: true,
        controlsConfigured: true,
        writeBlocked: false,
        blockReason: null,
      },
      pipeline: { verified: true, executionReady: true },
      now: new Date("2026-07-12T12:00:00.000Z"),
    });
    expect(
      ready.queue.adCandidates?.items[0]?.sourceAuthority
        ?.executionReadiness,
    ).toBe("live_preflight_required");
    expect(
      raw.queue.adCandidates?.items[0]?.sourceAuthority?.executionReadiness,
    ).toBe("governance_unavailable");

    const killed = applyMetaExecutionGovernanceToReadModel({
      model: raw,
      governance: {
        verified: true,
        controlsConfigured: true,
        writeBlocked: true,
        blockReason: "business_kill_switch",
      },
      pipeline: { verified: true, executionReady: true },
      now: new Date("2026-07-12T12:00:00.000Z"),
    });
    expect(
      killed.queue.adCandidates?.items[0]?.sourceAuthority
        ?.executionReadiness,
    ).toBe("kill_switched");

    const stale = applyMetaExecutionGovernanceToReadModel({
      model: raw,
      governance: {
        verified: true,
        controlsConfigured: true,
        writeBlocked: false,
        blockReason: null,
      },
      pipeline: { verified: true, executionReady: true },
      now: new Date("2026-07-12T18:00:01.000Z"),
    });
    expect(stale.queue.adCandidates?.items[0]?.sourceAuthority).toMatchObject({
      actionEligible: true,
      executionReadiness: "stale_decision",
      decisionFreshness: { status: "stale" },
    });

    const briefingInventory = applyMetaExecutionGovernanceToCanonicalDecisions({
      decisions: [raw.queue.adCandidates!.items[0]!],
      governance: {
        verified: true,
        controlsConfigured: true,
        writeBlocked: false,
        blockReason: null,
      },
      pipeline: { verified: true, executionReady: true },
      now: new Date("2026-07-12T12:00:00.000Z"),
    });
    expect(briefingInventory[0]?.sourceAuthority?.executionReadiness).toBe(
      "live_preflight_required",
    );
    expect(briefingInventory[0]).not.toBe(raw.queue.adCandidates!.items[0]);
    expect(
      raw.queue.adCandidates?.items[0]?.sourceAuthority?.executionReadiness,
    ).toBe("governance_unavailable");
  });

  /*
   * A Main-campaign Scale is an ACT verdict, and briefing still does not put it
   * in Action Now. Those are two separate facts and this case holds both.
   *
   * D016 and GC-055 make the first one: `scale` answers "is this creative a
   * winner?", and the campaign kind only chooses WHICH execution move the CTA
   * offers -- "Scale budget" for a Main campaign, "Promote to main" for a Test
   * one. GC-055's expected primary decision is Scale. This case used to assert
   * `decisionState: "monitor"`, which came from `projectMetaDecisionSemantics`
   * admitting `scale` as an act only for `test` and `mixed` roles: it demoted
   * the winners in exactly the campaigns that carry the budget, with no
   * blocker, no held verdict and no reason an operator could read.
   *
   * The second fact is `canonicalLane` (app/api/creatives/briefing/canonical-
   * projection.ts): only an action-eligible Cut at `live_preflight_required`
   * reaches the `action` lane, because Cut is the one exact-Ad route with a
   * provider-validated execution handoff. So the winner stays in `watching`
   * while carrying full server-side authority -- verdict and execution are
   * separate, which is the property this case now pins.
   */
  it("serves a native Main Scale as an act verdict that briefing keeps out of Action Now", () => {
    const model = nativeModel([
      nativeSnapshot("120000000000000007", {
        label: "scale",
        raw_label: "scale",
        authorized_action: "scale",
        reason: "Exact Ad evidence is above the account target.",
        ratio_to_target: 1.4,
        roas: 2.8,
        recent7d_roas: 2.6,
      }),
    ]);
    const decision = model.queue.adCandidates?.items[0];

    expect(decision?.classification).toMatchObject({
      lifecycleRole: { value: "main" },
      decisionState: "act",
      buyerAction: "scale",
      heldAction: null,
    });
    expect(decision?.sourceAuthority).toMatchObject({
      actionEligible: true,
      reviewOnlyReason: null,
      authorizedAction: "scale",
    });
    expect(
      projectCanonicalNativeAdDecisionToBriefing({ decision: decision! }),
    ).toMatchObject({
      lane: "watching",
      card: {
        sourceDecisionActionEligible: true,
        sourceDecisionAuthorizedAction: "scale",
      },
    });
  });

  it("fails native action authority closed when current hierarchy state is unavailable", () => {
    const model = nativeModel([
      nativeSnapshot("120000000000000009", {
        campaign_status: null,
        adset_status: null,
        ad_status: null,
      }),
    ]);

    expect(model.queue.adCandidates?.items).toHaveLength(0);
    expect(model.queue.inactiveAssets).toMatchObject({
      inactiveCount: 0,
      unknownCount: 1,
    });
    expect(model.queue.inactiveAssets?.items[0]).toMatchObject({
      deliveryScope: {
        state: "unknown",
        campaignStatus: null,
        adsetStatus: null,
        adStatus: null,
      },
      sourceAuthority: {
        actionEligible: false,
        reviewOnlyReason: "current_hierarchy_status_is_unknown",
        authorizedAction: null,
      },
    });
    expect(
      projectCanonicalNativeAdDecisionToBriefing({
        decision: model.queue.inactiveAssets!.items[0]!,
      }),
    ).toMatchObject({
      lane: "watching",
      card: {
        sourceDecisionActionEligible: false,
        sourceDecisionAuthorizedAction: null,
      },
    });
  });

  it.each([
    ["campaign", "120000000000000011", { campaign_status: "WITH_ISSUES" }],
    ["ad set", "120000000000000012", { adset_status: "WITH_ISSUES" }],
    ["ad", "120000000000000013", { ad_status: "WITH_ISSUES" }],
  ] as const)(
    "keeps a WITH_ISSUES %s visible but advisory-only",
    (_level, adId, statusOverride) => {
      const model = nativeModel([nativeSnapshot(adId, statusOverride)]);

      expect(model.queue.adCandidates?.items).toHaveLength(0);
      expect(model.queue.inactiveAssets?.items).toHaveLength(1);
      expect(model.queue.inactiveAssets?.items[0]).toMatchObject({
        deliveryScope: { state: "inactive" },
        sourceAuthority: {
          status: "native_exact",
          actionEligible: false,
          reviewOnlyReason: "current_hierarchy_is_not_active",
          authorizedAction: null,
        },
      });
    },
  );

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
        authorizedAction: null,
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

  it("classifies every generation-integrity failure before serving a bundle", () => {
    const row = nativeSnapshot("120000000000000031");
    const generation = nativeBuildGeneration([row]);
    const validate = (
      snapshotRows: readonly MetaNativeDecisionSnapshotSourceRow[],
      generationOverrides: Partial<typeof generation> = {},
    ) =>
      validateMetaNativeDecisionGenerationBundle({
        businessId: "biz_1",
        providerAccountId: "act_1",
        generation: { ...generation, ...generationOverrides },
        snapshotRows,
      });

    expect(validate([])).toMatchObject({
      status: "unavailable",
      validationIssue: "snapshot_count_mismatch",
    });
    expect(validate([{ ...row, lineage_valid: false }])).toMatchObject({
      status: "unavailable",
      validationIssue: "lineage_incomplete",
    });
    expect(validate([{ ...row, as_of_date: "2026-07-11" }])).toMatchObject({
      status: "unavailable",
      validationIssue: "snapshot_as_of_mismatch",
    });
    expect(
      validate([{ ...row, engine_version: "v3-prior-native-epoch" }]),
    ).toMatchObject({
      status: "unavailable",
      validationIssue: "engine_epoch_mismatch",
    });
    expect(validate([{ ...row, input_hash: "not-a-hash" }])).toMatchObject({
      status: "unavailable",
      validationIssue: "input_hash_invalid",
    });
    expect(validate([{ ...row, blocked_action_type: "cut" }])).toMatchObject({
      status: "unavailable",
      validationIssue: "snapshot_authority_invalid",
    });
    expect(validate([{ ...row, authorized_action: null }])).toMatchObject({
      status: "unavailable",
      validationIssue: "snapshot_authority_invalid",
    });
    expect(
      validate([
        {
          ...row,
          label: "keep",
          authorized_action: null,
          blocked_action_type: "cut",
        },
      ]),
    ).toMatchObject({
      status: "unavailable",
      validationIssue: "snapshot_authority_invalid",
    });
    expect(
      validate([
        {
          ...row,
          label: "keep",
          authorized_action: null,
          blocked_action_type: "cut",
          badges: [{ type: "pending_transition" }],
        },
      ]),
    ).toMatchObject({
      status: "available",
      validationIssue: null,
    });
    expect(validate([row], { manifestHash: "f".repeat(64) })).toMatchObject({
      status: "unavailable",
      validationIssue: "manifest_hash_mismatch",
    });
  });

  it("fails the complete native inventory closed when one canonical projection is invalid", () => {
    const row = nativeSnapshot("120000000000000032", {
      truth_source: "not-a-truth-source",
    });
    const inventory = buildNativeMetaCanonicalDecisionInventory({
      businessId: "biz_1",
      providerAccountId: "act_1",
      generation: nativeBuildGeneration([row]),
      snapshotRows: [row],
      campaignContextRows: [context()],
    });

    expect(inventory).toEqual({
      status: "unavailable",
      generation: null,
      items: [],
      unavailableReason: "native_canonical_projection_incomplete",
    });
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
    // `risk_tier_unclassified` is a statement about THIS pipeline — the
    // risk-tier producer is not persisted — so it informs and never gates. It
    // used to be appended to every canonical decision's blocker list
    // unconditionally, which made `blockers.length > 0` true for every ad the
    // server could produce and silently vetoed every action guarded on it.
    expect(
      item.classification.blockers.map((blocker) => blocker.code),
    ).not.toContain("risk_tier_unclassified");
    expect(item.classification.advisories).toEqual([
      expect.objectContaining({
        code: "risk_tier_unclassified",
        label: "Risk is unclassified",
        category: "risk",
        reason: "risk_tier_producer_not_persisted",
      }),
    ]);
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

  it("demoting the risk-tier advisory changes no lane and no classification", () => {
    // The read model also injected `risk_tier_unclassified` into the blocker
    // codes it hands the semantics projector. No branch in
    // `projectMetaDecisionSemantics` reads that code and it is not one of the
    // freshness authority blockers, so the injection was inert — this proves
    // it, rather than asserting it in a comment. If a future resolution branch
    // starts consulting the code, this fails and the demotion has to be
    // re-argued instead of quietly reclassifying rows.
    const shapes = [
      {
        legacyBuyerAction: "cut" as const,
        sourceLabel: "cut",
        lifecycleRole: "main" as const,
        badgeCodes: [] as string[],
        heldAction: null,
        authorityBlocker: null,
      },
      {
        legacyBuyerAction: "scale" as const,
        sourceLabel: "scale",
        lifecycleRole: "test" as const,
        badgeCodes: ["fatigue_fatigued"],
        heldAction: "scale" as const,
        authorityBlocker: "profile_hard_action_ineligible" as const,
      },
      {
        legacyBuyerAction: "diagnose_data" as const,
        sourceLabel: "diagnose",
        lifecycleRole: "label_needed" as const,
        badgeCodes: [] as string[],
        heldAction: null,
        authorityBlocker: null,
      },
    ];
    for (const shape of shapes) {
      const without = projectMetaDecisionSemantics({
        ...shape,
        blockerCodes: [],
      });
      const with_ = projectMetaDecisionSemantics({
        ...shape,
        blockerCodes: ["risk_tier_unclassified"],
      });
      expect(with_).toEqual(without);
    }

    // And end to end: the served classification for a decision that used to
    // carry the code is unchanged in every field a lane is read from.
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [snapshot("creative_1", { label: "cut" })],
      identityRows: [identity("creative_1")],
      campaignContextRows: [context()],
      generatedAt: "2026-07-10T12:00:00.000Z",
    });
    const item = model.queue.sections.creative_rotation.items[0]!;
    expect(item.classification).toMatchObject({
      queueSection: "creative_rotation",
      decisionState: "monitor",
      buyerAction: "cut",
      heldAction: null,
      resolution: null,
      blockers: [],
    });
  });

  it("keeps every real gate in the blocker list that action authority reads", () => {
    // The demotion moved exactly one code. An authority blocker persisted by
    // the engine and a lifecycle-role blocker are both still blockers, and both
    // still sit in the field `blockers.length > 0` guards read.
    const held = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [
        snapshot("creative_held", {
          label: "keep",
          pre_authority_label: "cut",
          authority_blocker: "recent_recovery_unverifiable",
          blocked_action_type: "cut",
        }),
      ],
      identityRows: [identity("creative_held")],
      campaignContextRows: [context()],
      generatedAt: "2026-07-10T12:00:00.000Z",
    });
    const heldItem = held.queue.sections.creative_rotation.items[0]!;
    expect(
      heldItem.classification.blockers.map((blocker) => blocker.code),
    ).toContain("recent_recovery_unverifiable");
    expect(heldItem.classification.decisionState).toBe("blocked");

    const unlabeled = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [snapshot("creative_unlabeled")],
      identityRows: [identity("creative_unlabeled")],
      campaignContextRows: [],
      generatedAt: "2026-07-10T12:00:00.000Z",
    });
    const unlabeledItem = unlabeled.queue.sections.creative_rotation.items[0]!;
    expect(
      unlabeledItem.classification.blockers.map((blocker) => blocker.code),
    ).toContain("campaign_context_unresolved");
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

  it.each([
    ["scale", "test", "scale"],
    ["cut", "main", "cut"],
    ["refresh", "test", "refresh"],
  ] as const)(
    "keeps high-confidence legacy %s compatibility visible but review-only",
    (label, campaignKind, buyerAction) => {
      const creativeId = `creative_legacy_${label}`;
      const model = buildMetaDecisionsWorkspaceReadModel({
        businessId: "biz_1",
        providerAccountId: "act_1",
        snapshotRows: [
          snapshot(creativeId, {
            label,
            confidence: 92,
          }),
        ],
        identityRows: [identity(creativeId)],
        campaignContextRows: [context({ kind: campaignKind })],
      });
      const decision = model.queue.adCandidates?.items[0]!;

      expect(model.source.authority).toBe("legacy_creative");
      expect(decision.parentChain.ad?.id).toMatch(/^\d+$/);
      expect(decision.sourceDecision.confidenceBand).toBe("high");
      expect(decision.classification).toMatchObject({
        decisionState: "monitor",
        buyerAction,
        executionAction: null,
      });
      expect(decision.identityResolution).toMatchObject({
        basis: "single_ad_creative_equivalent",
        adActionEligible: true,
      });
      expect(decision.sourceAuthority).toMatchObject({
        status: "legacy_review_only",
        actionEligible: false,
        authorizedAction: null,
      });
    },
  );

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

  it("keeps legacy exact-identity candidates out of Act Now during state classification", () => {
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
        act: { preCapCount: 0, selectedCount: 0 },
        blocked: { preCapCount: 0, selectedCount: 0 },
        monitor: { preCapCount: 101, selectedCount: 60 },
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

  it("keeps mixed-lane 60 and 120 responses as prefixes of the 300-row response", () => {
    const adId = (index: number) =>
      `120000${String(index + 1).padStart(12, "0")}`;
    const act = Array.from({ length: 200 }, (_, index) =>
      nativeSnapshot(adId(index)),
    );
    const blocked = Array.from({ length: 80 }, (_, index) =>
      nativeSnapshot(adId(200 + index), {
        label: "test_more",
        pre_authority_label: "cut",
        authority_blocker: "profile_hard_action_ineligible",
        raw_label: "test_more",
        blocked_action_type: "cut",
        authorized_action: null,
        badges: [
          {
            type: "campaign_context_unresolved",
            label: "Campaign context unresolved",
            severity: "warning",
          },
        ],
      }),
    );
    const monitor = Array.from({ length: 80 }, (_, index) =>
      nativeSnapshot(adId(280 + index), {
        label: "keep",
        pre_authority_label: "keep",
        raw_label: "keep",
        authorized_action: null,
      }),
    );
    const rows = [...act, ...blocked, ...monitor];

    const first = nativeModel(rows);
    const expanded = nativeModel(rows, { adCandidateLimit: 120 });
    const full = nativeModel(rows, { adCandidateLimit: 300 });
    const firstItems = first.queue.adCandidates?.items ?? [];
    const expandedItems = expanded.queue.adCandidates?.items ?? [];
    const fullItems = full.queue.adCandidates?.items ?? [];

    expect(first.queue.adCandidates).toMatchObject({
      limit: 60,
      eligiblePreCapCount: 360,
      selectedCount: 60,
      stateCounts: {
        act: { preCapCount: 200, selectedCount: 40 },
        blocked: { preCapCount: 80, selectedCount: 10 },
        monitor: { preCapCount: 80, selectedCount: 10 },
      },
    });
    expect(expanded.queue.adCandidates).toMatchObject({
      limit: 120,
      eligiblePreCapCount: 360,
      selectedCount: 120,
      stateCounts: {
        act: { preCapCount: 200, selectedCount: 100 },
        blocked: { preCapCount: 80, selectedCount: 10 },
        monitor: { preCapCount: 80, selectedCount: 10 },
      },
    });
    expect(full.queue.adCandidates).toMatchObject({
      limit: 300,
      eligiblePreCapCount: 360,
      selectedCount: 300,
      stateCounts: {
        act: { preCapCount: 200, selectedCount: 200 },
        blocked: { preCapCount: 80, selectedCount: 80 },
        monitor: { preCapCount: 80, selectedCount: 20 },
      },
    });
    expect(expandedItems.slice(0, 60).map((item) => item.decisionId)).toEqual(
      firstItems.map((item) => item.decisionId),
    );
    expect(fullItems.slice(0, 120).map((item) => item.decisionId)).toEqual(
      expandedItems.map((item) => item.decisionId),
    );
    const truePendingAdId = "120000999999999999";
    const os = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: full,
      currentAds: [
        ...rows.map((row) => ({
          providerAccountId: "act_1",
          adId: row.ad_id,
          adName: row.ad_name,
          campaignId: row.campaign_id,
          adsetId: row.adset_id,
          creativeId: row.creative_id,
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          providerUpdatedAt: null,
          fetchedAt: "2026-07-13T09:00:00.000Z",
        })),
        {
          providerAccountId: "act_1",
          adId: truePendingAdId,
          adName: "Current Ad awaiting exact evidence",
          campaignId: "cmp_1",
          adsetId: "adset_1",
          creativeId: "creative_pending",
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          providerUpdatedAt: null,
          fetchedAt: "2026-07-13T09:00:00.000Z",
        },
      ],
      currency: "USD",
    });
    /*
     * The decision counts describe DECISIONS, and the one ACTIVE Ad that no
     * producer has decided (`truePendingAdId`) is not one.
     *
     * This used to expect 361 and `blocked: 81` -- the 360 canonical decisions
     * plus that Ad. `buildMetaOsDecisionsPresentation` no longer folds
     * un-evaluated provider inventory into either number: it competed with real
     * verdicts for the response cap, made `blocked` a mixture of withheld
     * verdicts and un-evaluated rows, and inflated the count that drives the
     * surface's "load more" affordance. It is served instead as its own
     * `pendingInventoryCount` beside the
     * `active_ad_inventory_pending_native_decision` limitation, so no row in
     * `items` carries `pending_native_evidence` any more.
     */
    expect(os.ads.eligiblePreCapCount).toBe(360);
    expect(os.ads.statePreCapCounts).toEqual({
      act: 200,
      blocked: 80,
      monitor: 80,
    });
    expect(os.ads.pendingInventoryCount).toBe(1);
    expect(
      os.ads.items.filter(
        (item) => item.decisionAvailability === "pending_native_evidence",
      ),
    ).toEqual([]);
    expect(os.ads.items.some((item) => item.adId === truePendingAdId)).toBe(
      false,
    );
    expect(
      new Set(firstItems.map((item) => item.classification.decisionState)),
    ).toEqual(new Set(["act", "blocked", "monitor"]));
    expect(
      firstItems
        .slice(0, 10)
        .every((item) => item.classification.decisionState === "act"),
    ).toBe(true);
    expect(
      firstItems
        .slice(10, 20)
        .every((item) => item.classification.decisionState === "blocked"),
    ).toBe(true);
    expect(
      firstItems
        .slice(20, 30)
        .every((item) => item.classification.decisionState === "monitor"),
    ).toBe(true);
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

  it("does not synthesize a held Cut for a NON-NATIVE-EPOCH stop-loss row", () => {
    /*
      CODEX ROUND 4, ITEM 9 — an old row is read, never recomputed.

      `toDecisionOutput` used to reconstruct `blockedActionType: "cut"` whenever
      the persisted value was absent, the row's `engine_version` differed from
      the current native epoch, AND it carried a `stop_loss_review` badge. Prior
      epochs did not persist `blocked_action_type`, so the reconstruction was
      protective in intent — but it minted a typed CURRENT-semantics held action
      for a row this engine never produced, which is what item 9 forbids.

      THIS PATH IS THE ONE THAT WAS REACHABLE. A native bundle refuses a
      foreign-epoch row wholesale ("Native ad generation lineage or manifest is
      incomplete"), so the branch never fired there. The legacy snapshot path
      has no such gate and its rows carry `engine_version: "v3-test"` — never
      equal to the native epoch — so EVERY legacy row with a stop-loss badge and
      no persisted `blocked_action_type` was being given a synthesized Cut.

      Nothing is erased by removing it: the badge survives, and the row keeps
      its own version key.
    */
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [
        snapshot("legacy_stop_loss", {
          label: "keep",
          blocked_action_type: null,
          badges: [
            {
              type: "stop_loss_review",
              label: "Below break-even - automatic Cut authority unavailable",
              severity: "warning",
            },
          ],
        }),
      ],
      identityRows: [identity("legacy_stop_loss")],
      campaignContextRows: [],
    });

    const item = model.queue.sections.creative_rotation.items[0]!;
    /*
      `classification.heldAction` is the typed, observable consequence: the
      legacy `sourceDecision` envelope carries no `blockedActionType` field at
      all, so the synthesized value could only ever surface through the
      classification the presentation projects from it.
    */
    expect(item.classification.heldAction ?? null).toBeNull();
    expect(item.classification.buyerLabel ?? "").not.toMatch(/Cut · Held/i);

    // NOTHING IS ERASED: the evidence the synthesis was protecting survives on
    // its own terms, which is why removing the synthesis is safe.
    // `sourceDecision.badges` is a string[] of codes, not badge objects.
    expect(item.sourceDecision.badges).toContain("stop_loss_review");
    // And the row keeps its ORIGINAL version key, unrestamped.
    expect(item.sourceDecision.engineVersion).toBe("v3-test");
  });

  it("does not synthesize a held Cut from a native stop-loss review badge", () => {
    const model = nativeModel([
      nativeSnapshot("1200000000000000785", {
        label: "keep",
        pre_authority_label: "keep",
        authority_blocker: null,
        raw_label: "keep",
        blocked_action_type: null,
        authorized_action: null,
        badges: [
          {
            type: "below_breakeven",
            label: "Below breakeven",
            severity: "warning",
          },
          {
            type: "stop_loss_review",
            label: "Below break-even - automatic Cut authority unavailable",
            severity: "warning",
          },
        ],
        reason:
          "[below break-even - stop-loss review] Economic loss is visible but expanded Cut authority is unavailable.",
      }),
    ]);
    const item = model.queue.adCandidates?.items[0];

    expect(item?.classification).toMatchObject({
      decisionState: "monitor",
      heldAction: null,
      buyerAction: "test_more",
      executionAction: null,
    });
    expect(item?.classification.buyerLabel).not.toMatch(/Cut · Held/i);
    expect(item?.sourceDecision).toMatchObject({
      label: "keep",
      preAuthorityLabel: "keep",
      authorityBlocker: null,
    });
    expect(item?.sourceAuthority).toMatchObject({
      status: "native_exact",
      actionEligible: false,
      authorizedAction: null,
    });
  });

  it.each([
    {
      name: "missing recent evidence",
      badges: [
        {
          type: "missing_recent_data",
          label: "Recent break-even evidence unavailable",
          severity: "warning",
        },
      ],
      resolutionCode: "refresh_decision_data",
      owner: "integration",
    },
    {
      name: "thin recent evidence",
      badges: [],
      resolutionCode: "await_recent_evidence",
      owner: "system",
    },
  ])(
    "serves a D063 held Cut with null execution for $name",
    ({ badges, resolutionCode, owner }) => {
      const model = nativeModel([
        nativeSnapshot("120000000000000079", {
          label: "test_more",
          pre_authority_label: "cut",
          authority_blocker: "recent_recovery_unverifiable",
          raw_label: "test_more",
          blocked_action_type: "cut",
          authorized_action: null,
          badges,
        }),
      ]);
      const item = model.queue.adCandidates?.items[0];

      expect(item?.classification).toMatchObject({
        decisionState: "blocked",
        heldAction: "cut",
        legacyBuyerAction: "test_more",
        buyerAction: null,
        executionAction: null,
        assessment: { value: "below_target" },
        resolution: { code: resolutionCode, owner },
      });
      expect(item?.sourceDecision).toMatchObject({
        preAuthorityLabel: "cut",
        authorityBlocker: "recent_recovery_unverifiable",
        rawLabel: "test_more",
      });
      expect(item?.sourceAuthority).toMatchObject({
        status: "native_exact",
        actionEligible: false,
        authorizedAction: null,
      });
    },
  );

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
      value: "role_unresolved",
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
      if (sql.includes("FROM engine_v3_campaign_context_daily")) {
        return [
          {
            campaign_id: "cmp_1",
            inferred_kind: "main",
            confidence_class: "high",
            signal_scores_json: {},
            context_updated_at: "2026-07-09T10:00:00.000Z",
            resolver_version: "campaign-context-v2-account-scoped",
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
      String(sql).includes("FROM engine_v3_campaign_context_daily"),
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
      2,
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
    expect(String(generationCall?.[0])).toContain("run.business_id = $1::text");
  });

  it("falls back to visible legacy rows when the latest native account manifest is incomplete", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("WITH candidate_runs AS")) {
        return [
          {
            selection: "latest",
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

  /*
   * AREA 3 -- the last good decision survives a failed latest native job.
   *
   * Shape taken from production on 2026-09-07, where Grandmix
   * (act_805150454596350), IwaStore (act_1087566732415606) and TheSwaf
   * (act_822913786458311) all had a FAILED newest terminal run for as-of
   * 2026-09-07 over a COMPLETE success for 2026-09-06 -- TheSwaf's success
   * carried 768 hydrated ads against a 768-ad expected manifest. Before this
   * fallback the reader dropped all three accounts to legacy/unavailable and
   * the operator lost every exact-Ad decision.
   */
  function failedLatestNativeJob(
    overrides: Partial<MetaNativeDecisionGenerationSourceRow> = {},
  ): MetaNativeDecisionGenerationSourceRow {
    return {
      selection: "latest",
      job_status: "failed",
      job_run_id: "20000000-0000-4000-8000-000000000902",
      as_of_date: "2026-07-13",
      engine_version: NATIVE_AD_ENGINE_VERSION,
      // A failed run writes no per-account hydration receipt, so the query's
      // LEFT JOIN LATERAL leaves every receipt column NULL. Verified against
      // the three live accounts above.
      provider_account_ref_id: null,
      provider_account_id: null,
      expected_ad_count: null,
      expected_manifest_hash: null,
      hydrated_ad_count: null,
      hydrated_manifest_hash: null,
      authoritative_for_prune: null,
      ...overrides,
    };
  }

  it("serves the last successful exact-Ad generation, marked and read-only, when the latest native job failed", async () => {
    const rows = [
      nativeSnapshot("120000000000000901"),
      nativeSnapshot("120000000000000902"),
    ];
    const query = workspaceReadQuery({
      generationRows: [
        failedLatestNativeJob(),
        nativeGenerationForRows(rows, { selection: "last_success" }),
      ],
      nativeRows: rows,
      // These rows must be action-eligible BEFORE the degradation, or the
      // stripped authority below proves nothing: without a resolved campaign
      // context every one of them is already review-only for
      // `served_decision_is_not_actionable`.
      campaignContextRows: [campaignContextDbRow()],
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      adIds: rows.map((row) => row.ad_id),
      generatedAt: "2026-07-13T12:00:00.000Z",
    });
    const snapshotCall = query.mock.calls.find(([sql]) =>
      String(sql).includes(
        "FROM engine_v3_ad_decision_snapshots_daily snapshot",
      ),
    );

    expect(model.status).toBe("available");
    expect(model.source).toMatchObject({
      // Not "available": that is the age-independent kill for execution
      // authority, asserted through the real pipeline-health gate below.
      status: "unavailable",
      authority: "native_ad",
      table: "engine_v3_ad_decision_snapshots_daily",
      snapshotAsOf: "2026-07-12",
      computedAt: "2026-07-12T05:00:00.000Z",
      fallbackReason:
        "native_latest_job_failed_serving_last_successful_generation",
      generation: {
        jobRunId: "20000000-0000-4000-8000-000000000001",
        expectedAdCount: 2,
      },
    });
    // The snapshot read is pinned to the retained success, never to the failed
    // run, so one response can never mix two generations.
    expect(snapshotCall?.[1]?.[2]).toBe("20000000-0000-4000-8000-000000000001");
    expect(snapshotCall?.[1]?.[3]).toBe("2026-07-12");

    const items = model.queue.adCandidates?.items ?? [];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.sourceAuthority).toMatchObject({
        status: "native_exact",
        actionEligible: false,
        authorizedAction: null,
        reviewOnlyReason:
          "native_latest_job_failed_last_successful_generation_is_not_current",
        executionReadiness: "decision_not_authorized",
        // The served AGE, produced by the server, not inferred from prose.
        decisionFreshness: { status: "stale", ageHours: 31, maxAgeHours: 12 },
      });
      expect(item.sourceDecision.label).toBe("cut");
    }
  });

  it("strips execution authority from a degraded generation that is still inside the freshness window", () => {
    const rows = [nativeSnapshot("120000000000000903")];
    const build = (degraded: boolean) =>
      buildNativeMetaDecisionsWorkspaceReadModel({
        businessId: "biz_1",
        providerAccountId: "act_1",
        generation: nativeBuildGeneration(rows),
        snapshotRows: rows,
        campaignContextRows: [context()],
        sourceDegradation: degraded
          ? {
              reason:
                "native_latest_job_failed_serving_last_successful_generation",
              generation: nativeBuildGeneration(rows),
              latestTerminalJobRunId: "20000000-0000-4000-8000-000000000902",
              latestTerminalJobStatus: "failed",
              latestTerminalAsOfDate: "2026-07-12",
            }
          : null,
        generatedAt: "2026-07-12T12:00:00.000Z",
      });

    // Same rows, same instant, seven hours old: freshness alone would leave
    // this decision fully action-eligible.
    expect(
      build(false).queue.adCandidates?.items[0]?.sourceAuthority,
    ).toMatchObject({
      actionEligible: true,
      authorizedAction: "cut",
      reviewOnlyReason: null,
      decisionFreshness: { status: "fresh", ageHours: 7 },
    });
    const degraded = build(true);
    expect(
      degraded.queue.adCandidates?.items[0]?.sourceAuthority,
    ).toMatchObject({
      actionEligible: false,
      authorizedAction: null,
      reviewOnlyReason:
        "native_latest_job_failed_last_successful_generation_is_not_current",
      executionReadiness: "decision_not_authorized",
      // Still fresh, and still forbidden: the source is degraded, not the age.
      decisionFreshness: { status: "fresh", ageHours: 7 },
    });
    // Freshness may block execution, but it must not erase the verdict.
    expect(degraded.queue.adCandidates?.items[0]?.sourceDecision).toMatchObject(
      { label: "cut", confidence: 88 },
    );
  });

  /*
   * The degraded marker FILLS an empty review-only slot; it never takes one
   * that is already spoken for.
   *
   * `collectMetaCanonicalDecisions` deliberately walks
   * `queue.inactiveAssets.items` as well as the live lanes, and every Archive
   * row already carries its own `current_hierarchy_is_not_active` /
   * `current_hierarchy_status_is_unknown`. `inactiveAdNote`
   * (components/meta/decision-center/meta-decision-center-exact-adapter.ts)
   * branches on exactly those two codes and on nothing else, so overwriting
   * them collapsed every Archive row's explanation to a bare
   * "Current status — …" for the whole degraded window. That lane is recorded
   * there as 83 served Ad decisions on Grandmix (act_805150454596350) and 319
   * on TheSwaf (act_822913786458311) -- the two accounts this fallback exists
   * to rescue.
   */
  it("fills the degraded review-only reason without taking the Archive lane's own", () => {
    const rows = [
      nativeSnapshot("120000000000000910"),
      nativeSnapshot("120000000000000911", { campaign_status: "PAUSED" }),
    ];
    const degraded = buildNativeMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      generation: nativeBuildGeneration(rows),
      snapshotRows: rows,
      campaignContextRows: [context()],
      sourceDegradation: {
        reason: "native_latest_job_failed_serving_last_successful_generation",
        generation: nativeBuildGeneration(rows),
        latestTerminalJobRunId: "20000000-0000-4000-8000-000000000902",
        latestTerminalJobStatus: "failed",
        latestTerminalAsOfDate: "2026-07-12",
      },
      generatedAt: "2026-07-12T12:00:00.000Z",
    });

    // The live row had no reason of its own, so the degraded code takes the
    // slot and says why the row cannot act.
    expect(
      degraded.queue.adCandidates?.items[0]?.sourceAuthority,
    ).toMatchObject({
      actionEligible: false,
      authorizedAction: null,
      reviewOnlyReason:
        "native_latest_job_failed_last_successful_generation_is_not_current",
      executionReadiness: "decision_not_authorized",
    });
    expect(degraded.queue.inactiveAssets?.items).toHaveLength(1);
    expect(
      degraded.queue.inactiveAssets?.items[0]?.sourceAuthority,
    ).toMatchObject({
      // The Archive row's own explanation survives the degraded window …
      reviewOnlyReason: "current_hierarchy_is_not_active",
      // … and it still loses every scrap of execution authority.
      actionEligible: false,
      authorizedAction: null,
      executionReadiness: "decision_not_authorized",
    });
    // The degradation itself is stated on the envelope, so yielding the row's
    // slot loses nothing an operator or the execution gate can read.
    expect(degraded.source).toMatchObject({
      status: "unavailable",
      fallbackReason:
        "native_latest_job_failed_serving_last_successful_generation",
    });
  });

  it("refuses provider execution through the shared pipeline-health gate while the source is degraded", () => {
    const rows = [nativeSnapshot("120000000000000904")];
    const degradedModel = buildNativeMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      generation: nativeBuildGeneration(rows),
      snapshotRows: rows,
      campaignContextRows: [context()],
      sourceDegradation: {
        reason: "native_latest_job_failed_serving_last_successful_generation",
        generation: nativeBuildGeneration(rows),
        latestTerminalJobRunId: "20000000-0000-4000-8000-000000000902",
        latestTerminalJobStatus: "failed",
        latestTerminalAsOfDate: "2026-07-12",
      },
      generatedAt: "2026-07-12T12:00:00.000Z",
    });

    // runDecisionOriginAdExecutionPreflight builds its `pipeline` evidence from
    // exactly this function over exactly this read model
    // (lib/meta/decision-origin-action-preflight.ts), so this is the gate that
    // decides whether Apply and automation may reach the provider at all.
    const health = buildMetaDecisionPipelineHealth({
      operational: healthyOperationalPipeline(),
      decisionReadModel: degradedModel,
      now: new Date("2026-07-12T12:00:00.000Z"),
    });

    expect(health.executionReady).toBe(false);
    expect(health.blockers).toContain("decision_generation_missing");
    expect(health.blockers).toContain("decision_manifest_invalid");
    expect(health.manifest.reason).toBe(
      "native_latest_job_failed_serving_last_successful_generation",
    );

    // The same rows without the degradation clear the same gate, so the refusal
    // above is the degradation and not the fixture.
    expect(
      buildMetaDecisionPipelineHealth({
        operational: healthyOperationalPipeline(),
        decisionReadModel: buildNativeMetaDecisionsWorkspaceReadModel({
          businessId: "biz_1",
          providerAccountId: "act_1",
          generation: nativeBuildGeneration(rows),
          snapshotRows: rows,
          campaignContextRows: [context()],
          generatedAt: "2026-07-12T12:00:00.000Z",
        }),
        now: new Date("2026-07-12T12:00:00.000Z"),
      }).executionReady,
    ).toBe(true);
  });

  it("returns to latest-native atomically as soon as a new success is the latest terminal run", async () => {
    const retained = [nativeSnapshot("120000000000000905")];
    const recovered = [
      nativeSnapshot("120000000000000905", {
        snapshot_id: "00000000-0000-4000-8000-000000000905",
        job_run_id: "20000000-0000-4000-8000-000000000905",
        as_of_date: "2026-07-13",
        computed_at: "2026-07-13T05:00:00.000Z",
      }),
    ];
    const read = async (
      generationRows: MetaNativeDecisionGenerationSourceRow[],
      nativeRows: MetaNativeDecisionSnapshotSourceRow[],
    ) => {
      const query = workspaceReadQuery({ generationRows, nativeRows });
      vi.mocked(db.getDb).mockReturnValue({ query } as never);
      const model = await readMetaDecisionsWorkspaceReadModel({
        businessId: "biz_1",
        providerAccountId: "act_1",
        adIds: nativeRows.map((row) => row.ad_id),
        generatedAt: "2026-07-13T12:00:00.000Z",
      });
      const snapshotCall = query.mock.calls.find(([sql]) =>
        String(sql).includes(
          "FROM engine_v3_ad_decision_snapshots_daily snapshot",
        ),
      );
      return { model, jobRunIdRead: snapshotCall?.[1]?.[2] };
    };

    const degraded = await read(
      [
        failedLatestNativeJob(),
        nativeGenerationForRows(retained, { selection: "last_success" }),
      ],
      retained,
    );
    // The recovery run is now the latest terminal run, so the query's
    // last_success CTE selects nothing: there is no request in which one half
    // of the answer comes from the retained generation and the other from the
    // new one.
    const returned = await read(
      [
        nativeGenerationForRows(recovered, {
          selection: "latest",
          job_run_id: recovered[0]!.job_run_id,
        }),
      ],
      recovered,
    );

    expect(degraded.model.source).toMatchObject({
      status: "unavailable",
      fallbackReason:
        "native_latest_job_failed_serving_last_successful_generation",
      snapshotAsOf: "2026-07-12",
    });
    expect(degraded.jobRunIdRead).toBe(retained[0]!.job_run_id);

    expect(returned.model.source).toMatchObject({
      status: "available",
      authority: "native_ad",
      fallbackReason: null,
      snapshotAsOf: "2026-07-13",
      generation: { jobRunId: recovered[0]!.job_run_id },
    });
    expect(returned.jobRunIdRead).toBe(recovered[0]!.job_run_id);
    // No residue of the degraded envelope survives the return. (This row is
    // still review-only for its own reason -- the mocked read serves no
    // campaign context -- which is exactly why the assertion names the code it
    // must not be rather than asserting null.)
    expect(
      returned.model.queue.adCandidates?.items[0]?.sourceAuthority
        ?.reviewOnlyReason,
    ).not.toBe(
      "native_latest_job_failed_last_successful_generation_is_not_current",
    );
  });

  it("keeps the last-success fallback out of the skipped, foreign-epoch and unprovable paths", async () => {
    const rows = [nativeSnapshot("120000000000000906")];
    const lastSuccess = nativeGenerationForRows(rows, {
      selection: "last_success",
    });
    const cases = [
      {
        latest: failedLatestNativeJob({ job_status: "skipped" }),
        lastSuccess,
        nativeRows: rows,
        expected: "native_latest_job_skipped",
      },
      {
        latest: failedLatestNativeJob(),
        lastSuccess: {
          ...lastSuccess,
          engine_version: "v3-prior-native-epoch",
        },
        nativeRows: rows,
        expected: "native_latest_job_failed",
      },
      {
        // The retained generation claims two ads and only one is persisted, so
        // it cannot be proven complete. The reason names the FAILED LATEST RUN,
        // not the retained generation's own defect: pointing the operator at a
        // corrupt manifest would name the wrong generation entirely.
        latest: failedLatestNativeJob(),
        lastSuccess: nativeGenerationForRows(
          [...rows, nativeSnapshot("120000000000000908")],
          { selection: "last_success" },
        ),
        nativeRows: rows,
        expected: "native_latest_job_failed",
      },
    ];

    for (const testCase of cases) {
      const query = workspaceReadQuery({
        generationRows: [testCase.latest, testCase.lastSuccess],
        nativeRows: testCase.nativeRows,
      });
      vi.mocked(db.getDb).mockReturnValue({ query } as never);

      const model = await readMetaDecisionsWorkspaceReadModel({
        businessId: "biz_1",
        providerAccountId: "act_1",
        generatedAt: "2026-07-13T12:00:00.000Z",
      });

      expect(model.source).toMatchObject({
        authority: "legacy_creative",
        fallbackReason: testCase.expected,
      });
    }
  });

  /*
   * The retained generation has a MAXIMUM AGE.
   *
   * Nothing used to bound how old the last success could be, so a run that had
   * been failing for a month kept serving that month-old generation with its
   * original label and confidence, marked only by a code and
   * `decisionFreshness.ageHours`. `NATIVE_DECISION_LAST_SUCCESS_MAX_AGE_DAYS`
   * is seven days -- the width of the engine's own recent window -- and past it
   * the reader returns to the pre-existing behaviour and reports the true
   * `native_latest_job_failed`.
   *
   * Both arms use the same rows and the same failed latest run; only the
   * serving instant moves, so the boundary is the only thing under test.
   */
  it("stops serving the retained generation past the last-success age ceiling", async () => {
    // Retained generation as-of 2026-07-12; the failed latest run is 2026-07-20.
    const rows = [nativeSnapshot("120000000000000912")];
    const readAt = async (generatedAt: string) => {
      const query = workspaceReadQuery({
        generationRows: [
          failedLatestNativeJob({ as_of_date: "2026-07-20" }),
          nativeGenerationForRows(rows, { selection: "last_success" }),
        ],
        nativeRows: rows,
      });
      vi.mocked(db.getDb).mockReturnValue({ query } as never);
      return readMetaDecisionsWorkspaceReadModel({
        businessId: "biz_1",
        providerAccountId: "act_1",
        generatedAt,
      });
    };

    // Exactly seven days old: still the last good decision, still served.
    expect((await readAt("2026-07-19T23:00:00.000Z")).source).toMatchObject({
      status: "unavailable",
      authority: "native_ad",
      snapshotAsOf: "2026-07-12",
      fallbackReason:
        "native_latest_job_failed_serving_last_successful_generation",
    });
    // One day further and it is no longer offered at all.
    expect((await readAt("2026-07-20T00:00:00.000Z")).source).toMatchObject({
      authority: "legacy_creative",
      fallbackReason: "native_latest_job_failed",
    });
  });

  /*
   * A defect in the FALLBACK CANDIDATE may kill the candidate. It may not
   * rename the authoritative fault.
   *
   * The receipt lateral join is per account, so two rows for one selection mean
   * that run claimed the same account twice. Failing both selections together
   * meant a duplicated `last_success` receipt reported
   * `native_account_receipt_cardinality_invalid` to EVERY caller -- including
   * Creative Briefing and engine-v3, which never opted into the fallback and
   * whose real, actionable fault was that the latest run failed. (Production
   * carries no duplicate receipts today, so this was latent.)
   */
  it("lets a duplicated retained receipt kill only the fallback, not the reported fault", async () => {
    const rows = [nativeSnapshot("120000000000000913")];
    const lastSuccess = nativeGenerationForRows(rows, {
      selection: "last_success",
    });
    vi.mocked(db.getDb).mockReturnValue({
      query: workspaceReadQuery({
        generationRows: [
          failedLatestNativeJob(),
          lastSuccess,
          { ...lastSuccess },
        ],
        nativeRows: rows,
      }),
    } as never);

    // The readers that never asked for the fallback hear the true fault.
    await expect(
      readValidatedMetaNativeDecisionGenerationBundle({
        businessId: "biz_1",
        providerAccountId: "act_1",
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      unavailableReason: "native_latest_job_failed",
    });
    // The workspace, which did ask, simply has no candidate to serve.
    expect(
      (
        await readMetaDecisionsWorkspaceReadModel({
          businessId: "biz_1",
          providerAccountId: "act_1",
          generatedAt: "2026-07-13T12:00:00.000Z",
        })
      ).source,
    ).toMatchObject({
      authority: "legacy_creative",
      fallbackReason: "native_latest_job_failed",
    });

    // A duplicated LATEST receipt is a defect in the authoritative answer
    // itself, and still stops every caller.
    vi.mocked(db.getDb).mockReturnValue({
      query: workspaceReadQuery({
        generationRows: [
          failedLatestNativeJob(),
          failedLatestNativeJob({
            job_run_id: "20000000-0000-4000-8000-000000000903",
          }),
        ],
        nativeRows: rows,
      }),
    } as never);
    await expect(
      readValidatedMetaNativeDecisionGenerationBundle({
        businessId: "biz_1",
        providerAccountId: "act_1",
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      unavailableReason: "native_account_receipt_cardinality_invalid",
    });
  });

  it("keeps the canonical inventory readers failing closed on a failed latest job", async () => {
    const rows = [nativeSnapshot("120000000000000907")];
    const query = workspaceReadQuery({
      generationRows: [
        failedLatestNativeJob(),
        nativeGenerationForRows(rows, { selection: "last_success" }),
      ],
      nativeRows: rows,
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    // Creative Briefing and the engine-v3 evidence route serve this inventory
    // directly, with no envelope that could carry the degraded marker. They
    // must keep refusing rather than inherit the workspace's fallback.
    const inventory = await readMetaNativeCanonicalDecisionInventory({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });
    const bundle = await readValidatedMetaNativeDecisionGenerationBundle({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });

    expect(inventory).toMatchObject({
      status: "unavailable",
      unavailableReason: "native_latest_job_failed",
    });
    expect(bundle).toMatchObject({
      status: "unavailable",
      unavailableReason: "native_latest_job_failed",
    });
  });

  /*
   * THE RETAINED GENERATION IS SELECTED BY THIS ACCOUNT'S RECEIPT, IN SQL.
   *
   * The candidate CTE used to rank successes business-globally and take one,
   * leaving the account receipt to be checked afterwards in TypeScript. On
   * production that is not an edge case: read read-only against prod on
   * 2026-09-07, of the 283 successful runs carrying a receipt for
   * act_805150454596350 (Grandmix) in the previous 30 days, 275 carry an
   * INCOMPLETE receipt for it (expected_ad_count 0 against 2,529 hydrated rows,
   * authoritative_for_prune false) and 8 are complete -- so the business-global
   * pick landed on an unusable receipt roughly 97% of the time and the whole
   * fallback went dark with a complete generation sitting right behind it.
   * 979a04f6/act_904404985140555 has 1,018 successes and not one complete
   * receipt for it, which is a fallback that must never be offered at all.
   *
   * The predicate has to be in SQL because only SQL sees the runs that did not
   * win; this asserts WHICH selection each predicate belongs to, because the
   * two requirements are opposite and live in one string.
   */
  it("selects the retained generation by this account's own complete receipt", () => {
    const candidate = cteBody(
      READ_NATIVE_DECISION_GENERATION_QUERY,
      "last_success_candidates",
    );
    const latest = cteBody(
      READ_NATIVE_DECISION_GENERATION_QUERY,
      "latest_effective_terminal_job",
    );

    // The candidate is scoped to a receipt for THIS account ($2) that is
    // complete on every field the shared receipt test reads.
    expect(candidate).toContain("receipt->>'provider_account_id' = $2");
    expect(candidate).toContain(
      "COALESCE(receipt->>'provider_account_ref_id', '') <> ''",
    );
    expect(candidate).toContain(
      "receipt->>'hydrated_ad_count' = receipt->>'expected_ad_count'",
    );
    expect(candidate).toContain(
      "receipt->>'hydrated_manifest_hash'\n                = receipt->>'expected_manifest_hash'",
    );
    expect(candidate).toContain("receipt->>'authoritative_for_prune' = 'true'");
    // …in this engine epoch, inside the age ceiling, newest first.
    expect(candidate).toContain("candidate.engine_version = $6");
    expect(candidate).toContain("candidate.as_of_date >= $7::date - $8::int");
    expect(candidate).toContain("ORDER BY candidate.as_of_date DESC");

    // The AUTHORITATIVE selection stays business-global and cross-epoch: it is
    // the newest terminal run whatever its epoch or receipt, so a broken latest
    // run is REPORTED rather than skipped over in SQL. Narrowing this CTE the
    // same way would hide the fault the operator has to fix.
    expect(latest).not.toContain("receipt");
    expect(latest).not.toContain("engine_version");
    expect(latest).not.toContain("$6");

    // Candidate order is part of the answer, so the outer join must not decide
    // it. @see lastSuccessfulGenerationDegradation
    expect(READ_NATIVE_DECISION_GENERATION_QUERY).toContain(
      "ORDER BY job.selection, job.as_of_date DESC, job.started_at DESC, job.id DESC",
    );
    // The business-global CTE this replaced is gone, not shadowed.
    expect(READ_NATIVE_DECISION_GENERATION_QUERY).not.toContain(
      "last_successful_terminal_job",
    );
  });

  /*
   * A DEFECTIVE NEWEST CANDIDATE DOES NOT CONSUME THE SLOT.
   *
   * Two arms, both of which the query can really return. A run that claimed
   * this account TWICE arrives as two rows for one job_run_id and is ambiguous;
   * a run whose receipt for this account is incomplete is filtered in SQL and
   * refused again by the shared receipt test, which is the defence-in-depth
   * half. Either way the walk must move to the next candidate rather than treat
   * the fallback as spent -- a later run's data fault says nothing about an
   * earlier complete generation.
   */
  it("walks past a defective newest candidate to the newest provable one", async () => {
    const retained = [nativeSnapshot("120000000000000920")];
    const newerBroken = (
      overrides: Partial<MetaNativeDecisionGenerationSourceRow>,
    ) =>
      nativeGenerationForRows(retained, {
        selection: "last_success",
        job_run_id: "20000000-0000-4000-8000-000000000921",
        as_of_date: "2026-07-12",
        ...overrides,
      });
    const provable = nativeGenerationForRows(retained, {
      selection: "last_success",
    });
    const readWith = async (
      generationRows: MetaNativeDecisionGenerationSourceRow[],
    ) => {
      vi.mocked(db.getDb).mockReturnValue({
        query: workspaceReadQuery({ generationRows, nativeRows: retained }),
      } as never);
      return readMetaDecisionsWorkspaceReadModel({
        businessId: "biz_1",
        providerAccountId: "act_1",
        generatedAt: "2026-07-13T12:00:00.000Z",
      });
    };

    const duplicated = newerBroken({});
    const afterAmbiguous = await readWith([
      failedLatestNativeJob(),
      duplicated,
      { ...duplicated },
      provable,
    ]);
    // Production's exact incomplete shape: 0 expected against every row
    // hydrated, not authoritative for prune.
    const afterIncomplete = await readWith([
      failedLatestNativeJob(),
      newerBroken({ expected_ad_count: 0, authoritative_for_prune: false }),
      provable,
    ]);

    for (const model of [afterAmbiguous, afterIncomplete]) {
      expect(model.source).toMatchObject({
        status: "unavailable",
        authority: "native_ad",
        fallbackReason:
          "native_latest_job_failed_serving_last_successful_generation",
        // Served from the PROVABLE candidate, never from the defective one.
        generation: { jobRunId: provable.job_run_id },
      });
      expect(model.source.degraded?.servedGeneration.jobRunId).toBe(
        provable.job_run_id,
      );
      expect(model.source.degraded?.servedGeneration.jobRunId).not.toBe(
        "20000000-0000-4000-8000-000000000921",
      );
    }

    // The guard against over-correcting: walking past a defect must not become
    // walking past the ABSENCE of a provable candidate. With the defective row
    // alone there is nothing to serve and the true fault is reported.
    const noneProvable = await readWith([
      failedLatestNativeJob(),
      duplicated,
      { ...duplicated },
    ]);
    expect(noneProvable.source).toMatchObject({
      authority: "legacy_creative",
      fallbackReason: "native_latest_job_failed",
    });
    expect(noneProvable.source.degraded).toBeUndefined();
  });

  /*
   * EVERY FIELD OF THE RECEIPT TEST STILL KILLS THE FALLBACK ON ITS OWN.
   *
   * The candidate now clears an account/epoch/completeness predicate in SQL
   * before TypeScript sees it. That is a narrowing, and a narrowing is only
   * safe if the shared receipt test still refuses each defect by itself: a
   * retained generation must never clear a bar the authoritative path would not.
   */
  it.each([
    ["a foreign account id", { provider_account_id: "act_other" }],
    ["a missing account ref", { provider_account_ref_id: null }],
    ["an unparsable expected count", { expected_ad_count: "many" }],
    ["a hydration shortfall", { hydrated_ad_count: 0 }],
    ["a non-sha expected hash", { expected_manifest_hash: "nope" }],
    ["a manifest hash mismatch", { hydrated_manifest_hash: "c".repeat(64) }],
    ["a non-authoritative receipt", { authoritative_for_prune: false }],
  ] as const)(
    "refuses a retained generation with %s",
    async (_kind, overrides) => {
      const rows = [nativeSnapshot("120000000000000922")];
      vi.mocked(db.getDb).mockReturnValue({
        query: workspaceReadQuery({
          generationRows: [
            failedLatestNativeJob(),
            nativeGenerationForRows(rows, {
              selection: "last_success",
              ...overrides,
            }),
          ],
          nativeRows: rows,
        }),
      } as never);

      const model = await readMetaDecisionsWorkspaceReadModel({
        businessId: "biz_1",
        providerAccountId: "act_1",
        generatedAt: "2026-07-13T12:00:00.000Z",
      });

      expect(model.source).toMatchObject({
        authority: "legacy_creative",
        fallbackReason: "native_latest_job_failed",
      });
      expect(model.source.degraded).toBeUndefined();
    },
  );

  /*
   * BOTH IDENTITIES REACH THE PUBLIC CONTRACT, TOGETHER.
   *
   * `source.fallbackReason` says a degraded window is open and nothing more.
   * Naming the failed run -- "showing 2026-07-12's decisions; the 2026-07-13
   * run failed" -- needed the failed run's id, status and day, and until
   * `source.degraded` existed they reached no consumer at all. The two halves
   * travel in one block so a reader cannot pair a served generation with a
   * failed run it never sat behind.
   */
  it("serves the retained generation and the failed run as one public block", async () => {
    const retained = [nativeSnapshot("120000000000000923")];
    const failed = failedLatestNativeJob({
      job_run_id: "20000000-0000-4000-8000-000000000924",
      as_of_date: "2026-07-13",
    });
    vi.mocked(db.getDb).mockReturnValue({
      query: workspaceReadQuery({
        generationRows: [
          failed,
          nativeGenerationForRows(retained, { selection: "last_success" }),
        ],
        nativeRows: retained,
      }),
    } as never);

    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      generatedAt: "2026-07-13T12:00:00.000Z",
    });

    expect(model.source.degraded).toEqual({
      reason: "native_latest_job_failed_serving_last_successful_generation",
      servedGeneration: {
        jobRunId: retained[0]!.job_run_id,
        asOfDate: "2026-07-12",
      },
      latestTerminalRun: {
        jobRunId: "20000000-0000-4000-8000-000000000924",
        status: "failed",
        asOfDate: "2026-07-13",
      },
    });
    // The block agrees with the fields that already carried the served half, so
    // adding it created no second, disagreeing answer.
    expect(model.source.degraded?.servedGeneration.jobRunId).toBe(
      model.source.generation?.jobRunId,
    );
    expect(model.source.degraded?.servedGeneration.asOfDate).toBe(
      model.source.snapshotAsOf,
    );
    // …and it names a DIFFERENT run from the one being served, which is the
    // whole point of carrying both.
    expect(model.source.degraded?.latestTerminalRun.jobRunId).not.toBe(
      model.source.degraded?.servedGeneration.jobRunId,
    );

    // ADDITIVE: an undegraded envelope carries no such block, so a payload
    // serialized before this block existed reads exactly as it did -- absent
    // means "not degraded", which is what every stored payload already meant.
    const healthy = buildNativeMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      generation: nativeBuildGeneration(retained),
      snapshotRows: retained,
      campaignContextRows: [context()],
      generatedAt: "2026-07-12T12:00:00.000Z",
    });
    expect(healthy.source.degraded).toBeUndefined();
    expect("degraded" in healthy.source).toBe(false);
    expect(
      JSON.parse(JSON.stringify(healthy)).source.fallbackReason,
    ).toBeNull();
  });

  /*
   * AN ANCIENT RETAINED GENERATION IS NOT SOFTENED FOR ANYONE.
   *
   * Past NATIVE_DECISION_LAST_SUCCESS_MAX_AGE_DAYS the workspace returns to the
   * pre-existing behaviour, and the readers that never opted in must still hear
   * the AUTHORITATIVE fault. A ceiling that renamed `native_latest_job_failed`
   * into an age code for Creative Briefing and engine-v3 would have moved the
   * fallback's failure into paths that never asked for the fallback.
   */
  it("keeps every reader on the authoritative fault past the age ceiling", async () => {
    const rows = [nativeSnapshot("120000000000000925")];
    vi.mocked(db.getDb).mockReturnValue({
      query: workspaceReadQuery({
        generationRows: [
          failedLatestNativeJob({ as_of_date: "2026-07-30" }),
          nativeGenerationForRows(rows, { selection: "last_success" }),
        ],
        nativeRows: rows,
      }),
    } as never);
    const ancient = { generatedAt: "2026-07-30T12:00:00.000Z" };

    // Eighteen days past the retained as-of day, well beyond the seven-day
    // ceiling.
    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      ...ancient,
    });
    const inventory = await readMetaNativeCanonicalDecisionInventory({
      businessId: "biz_1",
      providerAccountId: "act_1",
      ...ancient,
    });
    const bundle = await readValidatedMetaNativeDecisionGenerationBundle({
      businessId: "biz_1",
      providerAccountId: "act_1",
      ...ancient,
    });

    expect(model.source).toMatchObject({
      authority: "legacy_creative",
      fallbackReason: "native_latest_job_failed",
    });
    expect(model.source.degraded).toBeUndefined();
    expect(inventory).toMatchObject({
      status: "unavailable",
      unavailableReason: "native_latest_job_failed",
    });
    expect(bundle).toMatchObject({
      status: "unavailable",
      unavailableReason: "native_latest_job_failed",
    });
  });

  /*
   * ADS DELETED SINCE THE RETAINED GENERATION.
   *
   * A retained generation is days old, so some of the Ads it decided may no
   * longer exist. The generation still has to prove itself against the manifest
   * it was WRITTEN with, and it can, because reconciliation RELABELS rows and
   * never drops them: the departed Ad keeps its identity, loses its status to
   * NOT_ACTIVE and lands in the Archive lane with its own explanation, so the
   * ad-id set the manifest hash was taken over is unchanged. Dropping it
   * instead would break the very proof that lets the generation be served, and
   * the whole degraded window would collapse to
   * native_generation_lineage_or_manifest_invalid -- naming a corrupt
   * generation for what is really an ordinary deletion.
   */
  it("keeps a degraded envelope provable when inventory has left since the retained generation", async () => {
    const retained = [
      nativeSnapshot("120000000000000926"),
      nativeSnapshot("120000000000000927"),
    ];
    vi.mocked(db.getDb).mockReturnValue({
      query: workspaceReadQuery({
        generationRows: [
          failedLatestNativeJob(),
          nativeGenerationForRows(retained, { selection: "last_success" }),
        ],
        nativeRows: retained,
      }),
    } as never);

    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      generatedAt: "2026-07-13T12:00:00.000Z",
      currentAdSourceComplete: true,
      // The second Ad of the retained generation no longer exists.
      currentAds: [
        {
          providerAccountId: "act_1",
          adId: retained[0]!.ad_id,
          adName: retained[0]!.ad_name,
          campaignId: "cmp_1",
          adsetId: "adset_1",
          creativeId: retained[0]!.creative_id,
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          providerUpdatedAt: null,
          fetchedAt: "2026-07-13T09:00:00.000Z",
        },
      ],
    });

    // The generation is still the retained one and still proves itself: a
    // departed Ad is not a corrupt manifest.
    expect(model.source).toMatchObject({
      status: "unavailable",
      authority: "native_ad",
      fallbackReason:
        "native_latest_job_failed_serving_last_successful_generation",
    });
    expect(model.source.fallbackReason).not.toBe(
      "native_generation_lineage_or_manifest_invalid",
    );
    // The mechanism, named: both decided Ads still travel, so the manifest the
    // generation was written with is still the manifest being proven.
    expect(model.source.generation?.expectedAdCount).toBe(2);
    expect(
      [
        ...(model.queue.adCandidates?.items ?? []),
        ...(model.queue.inactiveAssets?.items ?? []),
      ].map((item) => item.parentChain.ad?.id),
    ).toEqual(retained.map((row) => row.ad_id));
    const archived = model.queue.inactiveAssets?.items ?? [];
    expect(archived.map((item) => item.parentChain.ad?.id)).toEqual([
      retained[1]!.ad_id,
    ]);
    // The Archive row keeps its OWN reason; the degraded code does not take it.
    expect(archived[0]?.sourceAuthority).toMatchObject({
      reviewOnlyReason: "current_hierarchy_is_not_active",
      actionEligible: false,
      authorizedAction: null,
      executionReadiness: "decision_not_authorized",
    });
    // Every surviving row is review-only for the degraded reason.
    for (const item of model.queue.adCandidates?.items ?? []) {
      expect(item.sourceAuthority).toMatchObject({
        actionEligible: false,
        authorizedAction: null,
        executionReadiness: "decision_not_authorized",
      });
    }
  });

  /*
   * A STALE FALLBACK CLOSES EXECUTION *AND* CTA AUTHORITY, END TO END.
   *
   * The row-level strip and the pipeline-health refusal are each pinned above.
   * Neither one is what the operator sees: the Decision OS payload decides the
   * CTA, and it does so from `sourceAuthority.actionEligible` and
   * `executionReadiness` (`adAction`, decisions-os-presentation.ts). This runs
   * the real serve-time governance hydrator, the real health gate and the real
   * presentation over one degraded envelope, and the control arm proves the
   * same fixture would otherwise hand the operator an executable Cut.
   */
  it("closes execution and CTA authority end to end while the source is degraded", () => {
    const rows = [nativeSnapshot("120000000000000928")];
    const build = (degraded: boolean) =>
      applyMetaExecutionGovernanceToReadModel({
        model: buildNativeMetaDecisionsWorkspaceReadModel({
          businessId: "biz_1",
          providerAccountId: "act_1",
          generation: nativeBuildGeneration(rows),
          snapshotRows: rows,
          campaignContextRows: [context()],
          sourceDegradation: degraded
            ? {
                reason:
                  "native_latest_job_failed_serving_last_successful_generation",
                generation: nativeBuildGeneration(rows),
                latestTerminalJobRunId: "20000000-0000-4000-8000-000000000929",
                latestTerminalJobStatus: "failed",
                latestTerminalAsOfDate: "2026-07-12",
              }
            : null,
          generatedAt: "2026-07-12T12:00:00.000Z",
        }),
        governance: {
          verified: true,
          controlsConfigured: true,
          writeBlocked: false,
          blockReason: null,
        },
        pipeline: { verified: true, executionReady: true },
        now: new Date("2026-07-12T12:00:00.000Z"),
      });
    const present = (model: ReturnType<typeof build>) =>
      buildMetaOsDecisionsPresentation({
        actionNow: [],
        watching: [],
        nonSales: [],
        decisionReadModel: model,
        currency: "USD",
        pipelineHealth: buildMetaDecisionPipelineHealth({
          operational: healthyOperationalPipeline(),
          decisionReadModel: model,
          now: new Date("2026-07-12T12:00:00.000Z"),
        }),
        generatedAt: "2026-07-12T12:00:00.000Z",
      });

    // CONTROL: the same rows, the same instant, the same governance. The CTA is
    // a real provider write, so everything the degraded arm refuses below is
    // refused by the degradation and not by the fixture.
    const healthy = present(build(false));
    expect(healthy.source.health).toBe("healthy");
    expect(healthy.ads.items).not.toHaveLength(0);
    for (const item of healthy.ads.items) {
      expect(item.action).toMatchObject({
        code: "cut",
        intent: "execute",
        providerMutation: "pause",
      });
    }

    const degraded = present(build(true));
    expect(degraded.source).toMatchObject({
      health: "degraded",
      fallbackReason:
        "native_latest_job_failed_serving_last_successful_generation",
    });
    expect(degraded.ads.items).toHaveLength(healthy.ads.items.length);
    for (const item of degraded.ads.items) {
      // The verdict survives -- freshness may block execution but must not
      // erase a severe stop-loss verdict …
      expect(item.action.code).toBe("cut");
      // … and no CTA on it can reach the provider.
      expect(item.action.intent).toBe("review");
      expect(item.action.providerMutation).toBeNull();
    }
  });

  /*
   * WHAT THE ATOMIC SQL SWITCH DOES AND DOES NOT BUY.
   *
   * `READ_NATIVE_DECISION_GENERATION_QUERY` decides "latest, or retained" in
   * one statement, so no single read mixes the two. That is a property of the
   * READ. The route caches the decision read for 60s with a 240s
   * stale-while-revalidate under `shouldCache: result.ok && result.model.status
   * === "available"` -- and a degraded envelope IS `status: "available"`,
   * because the rows are real; it is `source.status` that says unavailable. So
   * the degraded envelope is cached like any other and the SERVED SURFACE can
   * lag the switch by that window in both directions.
   *
   * The claim this pins is therefore not "the switch is end-to-end atomic". It
   * is that a cached degraded envelope is SELF-DESCRIBING and INERT: it names
   * both runs, it authorizes nothing, and it cannot be mistaken for the current
   * generation by any consumer that reads the contract rather than the clock.
   */
  it("caches a degraded envelope as an available model that still authorizes nothing", async () => {
    const routeSource = readFileSync(
      "app/api/meta/decisions-workspace/route.ts",
      "utf8",
    );
    expect(routeSource).toContain(
      "shouldCache: (result) =>\n                result.ok && result.model.status === \"available\"",
    );
    expect(routeSource).toContain("ttlMs: 60_000");
    expect(routeSource).toContain("staleWhileRevalidateMs: 240_000");

    const rows = [nativeSnapshot("120000000000000930")];
    vi.mocked(db.getDb).mockReturnValue({
      query: workspaceReadQuery({
        generationRows: [
          failedLatestNativeJob(),
          nativeGenerationForRows(rows, { selection: "last_success" }),
        ],
        nativeRows: rows,
      }),
    } as never);
    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      generatedAt: "2026-07-13T12:00:00.000Z",
    });

    // This is the byte the route's shouldCache reads: a degraded envelope is
    // cacheable, and saying otherwise here would be wishing the lag away.
    expect(model.status).toBe("available");
    expect(model.source.status).toBe("unavailable");

    // A cache entry is a serialized copy, so everything the lag can serve must
    // survive JSON.
    const cached = JSON.parse(
      JSON.stringify(model),
    ) as typeof model;
    // Named, not merely equal: `toEqual` over two absent blocks would pass by
    // agreeing that neither exists, which is the state this exists to forbid.
    expect(cached.source.degraded).toEqual({
      reason: "native_latest_job_failed_serving_last_successful_generation",
      servedGeneration: { jobRunId: rows[0]!.job_run_id, asOfDate: "2026-07-12" },
      latestTerminalRun: {
        jobRunId: "20000000-0000-4000-8000-000000000902",
        status: "failed",
        asOfDate: "2026-07-13",
      },
    });
    expect(cached.source.degraded).toEqual(model.source.degraded);
    expect(cached.source.fallbackReason).toBe(
      "native_latest_job_failed_serving_last_successful_generation",
    );
    // Re-run the health gate over the CACHED copy at a later instant, as a
    // request served from the cache would: still no execution.
    const health = buildMetaDecisionPipelineHealth({
      operational: healthyOperationalPipeline(),
      decisionReadModel: cached,
      now: new Date("2026-07-13T12:04:00.000Z"),
    });
    expect(health.executionReady).toBe(false);
    expect(health.blockers).toContain("decision_generation_missing");
    for (const item of cached.queue.adCandidates?.items ?? []) {
      expect(item.sourceAuthority).toMatchObject({
        actionEligible: false,
        authorizedAction: null,
        executionReadiness: "decision_not_authorized",
      });
    }
  });

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

    const bundle = await readValidatedMetaNativeDecisionGenerationBundle({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });
    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });
    const generationCall = query.mock.calls.find(([sql]) =>
      sql.includes("WITH candidate_runs AS"),
    );

    expect(bundle).toMatchObject({
      status: "unavailable",
      unavailableReason: "native_latest_job_engine_mismatch",
      validationIssue: null,
    });
    expect(model.source).toMatchObject({
      authority: "legacy_creative",
      fallbackReason: "native_latest_job_engine_mismatch",
    });
    /*
     * RE-PINNED: the epoch filter is now in the query, and the CTE it is NOT in
     * is the point.
     *
     * `latest_effective_terminal_job` still ranks across epochs, which is what
     * makes the assertion above possible: a foreign-epoch latest run is
     * REPORTED as `native_latest_job_engine_mismatch` rather than skipped over
     * in SQL and silently replaced by an older same-epoch run. The last-success
     * CANDIDATE CTE does filter by epoch, because a foreign-epoch candidate can
     * never be served and must not occupy a candidate slot. Both halves are
     * asserted, so over-correcting in either direction fails here.
     */
    const sql = String(generationCall?.[0]);
    expect(cteBody(sql, "latest_effective_terminal_job")).not.toContain(
      "engine_version",
    );
    expect(cteBody(sql, "last_success_candidates")).toContain(
      "candidate.engine_version = $6",
    );
    expect(generationCall?.[1]).toEqual([
      "biz_1",
      "act_1",
      expect.any(String),
      null,
      expect.any(Number),
      NATIVE_AD_ENGINE_VERSION,
      // The serving day the age ceiling is measured against, and the ceiling.
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      NATIVE_DECISION_LAST_SUCCESS_MAX_AGE_DAYS,
    ]);
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes("FROM engine_v3_ad_decision_snapshots_daily snapshot"),
      ),
    ).toBe(false);
  });

  it.each([
    ["identical", {}],
    ["contradictory", { expected_manifest_hash: "f".repeat(64) }],
  ] as const)(
    "fails the native bundle closed for %s duplicate account receipts",
    async (_kind, duplicateOverrides) => {
      const row = nativeSnapshot("120000000000000034");
      const receipt = nativeGeneration(row);
      const query = workspaceReadQuery({
        generationRows: [receipt, { ...receipt, ...duplicateOverrides }],
        nativeRows: [row],
      });
      vi.mocked(db.getDb).mockReturnValue({ query } as never);

      const bundle = await readValidatedMetaNativeDecisionGenerationBundle({
        businessId: "biz_1",
        providerAccountId: "act_1",
      });
      const inventory = await readMetaNativeCanonicalDecisionInventory({
        businessId: "biz_1",
        providerAccountId: "act_1",
      });

      expect(bundle).toMatchObject({
        status: "unavailable",
        unavailableReason: "native_account_receipt_cardinality_invalid",
        validationIssue: null,
      });
      expect(inventory).toEqual({
        status: "unavailable",
        generation: null,
        items: [],
        unavailableReason: "native_account_receipt_cardinality_invalid",
      });
      expect(
        query.mock.calls.some(([sql]) =>
          String(sql).includes(
            "FROM engine_v3_ad_decision_snapshots_daily snapshot",
          ),
        ),
      ).toBe(false);
    },
  );

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
      NATIVE_AD_ENGINE_VERSION,
      // The as-of BOUND ($4) and the last-success age ceiling's serving day
      // ($7) are different clocks on purpose: $4 bounds which runs may be
      // considered at all, $7 measures how old the retained one is right now.
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      NATIVE_DECISION_LAST_SUCCESS_MAX_AGE_DAYS,
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
    expect(generationSql).toContain("WHEN run.status = 'running'");
    expect(generationSql).toContain(
      "make_interval(secs => $5::double precision / 1000.0)",
    );
    expect(generationSql).toContain("THEN 'failed'");
    expect(generationSql).toContain(
      "WHEN run.finished_at IS NULL\n            OR run.finished_at > statement_timestamp()\n          THEN 'failed'",
    );
    expect(generationSql).toContain("WHERE run.effective_status <> 'running'");
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
            selection: "latest",
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
    // D075 consumer sweep: an absent_unconfirmed winner serves NULL —
    // never a fabricated 'DELETED' provider state, never a resurrected
    // present status. The CASE arms fail closed for every non-present
    // presence value.
    for (const grain of ["campaign_state", "adset_state", "ad_state"]) {
      expect(String(nativeSnapshotCall?.[0])).toContain(
        `WHEN ${grain}.presence = 'present' THEN COALESCE(`,
      );
    }
    expect(String(nativeSnapshotCall?.[0])).not.toContain("ELSE 'DELETED'");
    expect(
      String(nativeSnapshotCall?.[0]).match(
        /state\.provider_account_ref_id = snapshot\.provider_account_ref_id/g,
      ),
    ).toHaveLength(3);
    expect(String(nativeSnapshotCall?.[0])).not.toContain(
      "campaign_state.configured_status,\n          campaign_dim.campaign_status",
    );
    expect(String(nativeSnapshotCall?.[0])).not.toContain(
      "adset_state.configured_status,\n          adset_dim.adset_status",
    );
    expect(String(nativeSnapshotCall?.[0])).not.toContain(
      "ad_state.configured_status,\n          ad_dim.ad_status",
    );
    expect(String(nativeSnapshotCall?.[0])).not.toContain(
      "creative_id = requested.creative_id",
    );
  });

  it("returns the full server-side native inventory independently of workspace caps", async () => {
    const rows = Array.from({ length: 305 }, (_, index) =>
      nativeSnapshot(`120000${String(index + 1).padStart(12, "0")}`),
    );
    const query = workspaceReadQuery({
      generationRows: [nativeGenerationForRows(rows)],
      nativeRows: rows,
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const inventory = await readMetaNativeCanonicalDecisionInventory({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });
    const workspace = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      adCandidateLimit: 300,
    });

    expect(inventory.status).toBe("available");
    if (inventory.status !== "available") return;
    expect(inventory.items).toHaveLength(305);
    expect(
      new Set(inventory.items.map((item) => item.parentChain.ad?.id)).size,
    ).toBe(305);
    expect(
      inventory.items.every(
        (item) =>
          item.identityGrain === "ad" &&
          item.sourceAuthority?.status === "native_exact" &&
          item.sourceAuthority.realAdId === item.parentChain.ad?.id,
      ),
    ).toBe(true);
    expect(workspace.queue.adCandidates).toMatchObject({
      limit: 300,
      eligiblePreCapCount: 305,
      selectedCount: 300,
    });
  });

  it("proves the full native manifest before reading only requested creatives", async () => {
    const rows = [
      nativeSnapshot("120000000000000101", {
        creative_id: "creative-shared",
      }),
      nativeSnapshot("120000000000000102", {
        creative_id: "creative-shared",
      }),
      nativeSnapshot("120000000000000103", {
        creative_id: "creative-other",
      }),
    ];
    const query = workspaceReadQuery({
      generationRows: [nativeGenerationForRows(rows)],
      nativeRows: rows,
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const inventory = await readMetaNativeCanonicalDecisionInventory({
      businessId: "biz_1",
      providerAccountId: "act_1",
      creativeIds: ["creative-shared"],
    });

    expect(inventory.status).toBe("available");
    if (inventory.status !== "available") return;
    expect(inventory.generation.expectedAdCount).toBe(3);
    expect(
      inventory.items.map((item) => item.parentChain.ad?.id).sort(),
    ).toEqual(["120000000000000101", "120000000000000102"]);
    const manifestCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("native-ad-serving-manifest"),
    );
    const subsetCall = query.mock.calls.find(
      ([sql]) =>
        String(sql).includes(
          "FROM engine_v3_ad_decision_snapshots_daily snapshot",
        ) && !String(sql).includes("native-ad-serving-manifest"),
    );
    expect(manifestCall).toBeTruthy();
    expect(subsetCall?.[1]?.[6]).toBe(true);
    expect(subsetCall?.[1]?.[7]).toEqual(["creative-shared"]);
  });

  it("serves only verified current Ads without falling back to stale creative rows", async () => {
    const rows = [
      nativeSnapshot("120000000000000111"),
      nativeSnapshot("120000000000000112"),
      nativeSnapshot("120000000000000113"),
    ];
    const query = workspaceReadQuery({
      generationRows: [nativeGenerationForRows(rows)],
      nativeRows: rows,
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      adIds: ["120000000000000112"],
      currentAdSourceComplete: true,
      currentAds: [
        {
          providerAccountId: "act_1",
          adId: "120000000000000112",
          adName: "Active Ad",
          campaignId: "campaign_1",
          campaignName: "Campaign",
          adsetId: "adset_1",
          creativeId: "creative_shared",
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          providerUpdatedAt: null,
          fetchedAt: "2026-07-16T12:00:00.000Z",
        },
      ],
    });

    expect(model.source).toMatchObject({
      authority: "native_ad",
      generation: { expectedAdCount: 3 },
    });
    const servedActiveIds = new Set([
      ...Object.values(model.queue.sections).flatMap((section) =>
        section.items.map((item) => item.parentChain.ad?.id),
      ),
      ...(model.queue.adCandidates?.items.map(
        (item) => item.parentChain.ad?.id,
      ) ?? []),
    ]);
    expect([...servedActiveIds]).toEqual(["120000000000000112"]);
    expect(model.queue.inactiveAssets?.items ?? []).toHaveLength(0);
    const subsetCall = query.mock.calls.find(
      ([sql]) =>
        String(sql).includes(
          "FROM engine_v3_ad_decision_snapshots_daily snapshot",
        ) && !String(sql).includes("native-ad-serving-manifest"),
    );
    expect(subsetCall?.[1]?.[8]).toBe(true);
    expect(subsetCall?.[1]?.[9]).toEqual(["120000000000000112"]);
  });

  it("fails closed when a current active Ad is absent from the proven generation", async () => {
    const rows = [nativeSnapshot("120000000000000121")];
    const query = workspaceReadQuery({
      generationRows: [nativeGenerationForRows(rows)],
      nativeRows: rows,
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const model = await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      adIds: ["120000000000000999"],
      currentAdSourceComplete: true,
      currentAds: [
        {
          providerAccountId: "act_1",
          adId: "120000000000000999",
          adName: "New active Ad",
          campaignId: "campaign_1",
          campaignName: "Campaign",
          adsetId: "adset_1",
          creativeId: "creative_new",
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          providerUpdatedAt: null,
          fetchedAt: "2026-07-16T12:00:00.000Z",
        },
      ],
    });

    expect(model.status).toBe("unavailable");
    expect(model.source.fallbackReason).toBe(
      "native_serving_subset_incomplete",
    );
  });

  it("keeps invalid bundles unavailable without querying legacy snapshots", async () => {
    const row = nativeSnapshot("120000000000000033", {
      lineage_valid: false,
    });
    const query = workspaceReadQuery({
      generationRows: [nativeGeneration(row)],
      nativeRows: [row],
      legacyRows: [snapshot("must_not_be_read")],
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const bundle = await readValidatedMetaNativeDecisionGenerationBundle({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });
    const inventory = await readMetaNativeCanonicalDecisionInventory({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });

    expect(bundle).toMatchObject({
      status: "unavailable",
      unavailableReason: "native_generation_lineage_or_manifest_invalid",
      validationIssue: "lineage_incomplete",
    });
    expect(inventory).toEqual({
      status: "unavailable",
      generation: null,
      items: [],
      unavailableReason: "native_generation_lineage_or_manifest_invalid",
    });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("scoped_history")),
    ).toBe(false);
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

    expect(legacy.contractVersion).toBe("meta-decisions-workspace.read.v4");
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

describe("the native snapshot read stays inside its query budget", () => {
  const source = readFileSync(
    "lib/meta/decisions-workspace-read-model.ts",
    "utf8",
  );

  /**
   * Every history lookup in the snapshot read has to be index-addressable AND
   * bounded, not merely correct.
   *
   * Two separate defects have shipped here, and each one produced the same
   * symptom: the read blew the 8 second query timeout, the catch reported
   * `native_schema_or_generation_read_failed`, and the Decision Center quietly
   * served an empty Creatives scope on every real account. Nothing looked
   * broken. A correctness test cannot see either of them; only the shape can
   * be pinned.
   *
   * 1. UNDER-CONSTRAINED PREDICATE. The lookup once named only
   *    `history.ad_id`, leaving `decision_entity_type` and
   *    `decision_entity_id` unconstrained in the middle of
   *    `engine_v3_ad_snapshots_ad_identity_unique`, so Postgres scanned ~15k
   *    history rows per snapshot row and discarded them: 309 million buffer
   *    hits, 258 seconds.
   *
   * 2. QUADRATIC RE-SCAN. With the predicate fixed, the run boundary was still
   *    found by a NOT EXISTS anti-join evaluated once per history row --
   *    O(ads x history x history). On a 3,200-ad account that inner scan ran
   *    25,453 times and burned 1,149,283 of the statement's 1,289,559 buffers;
   *    the read measured 12,068-23,052 ms and two production accounts timed
   *    out on every single request.
   *
   * The boundary must therefore be found ONCE per ad, by a bounded backward
   * scan that stops at the first differently-labelled day -- never by asking
   * the same question again for every day of the ad's history.
   */
  it("constrains both episode lookups on the decision entity, not the ad id alone", () => {
    const boundary = source.slice(
      source.indexOf("SELECT changed.as_of_date"),
      source.indexOf(") episode_boundary ON TRUE"),
    );
    const episode = source.slice(
      source.indexOf("SELECT MIN(history.as_of_date) AS episode_started_at"),
      source.indexOf(") episode ON TRUE"),
    );
    expect(boundary).not.toBe("");
    expect(episode).not.toBe("");

    for (const [alias, lateral] of [
      ["changed", boundary],
      ["history", episode],
    ] as const) {
      expect(
        lateral,
        `${alias} must pin decision_entity_type so the unique index is usable`,
      ).toContain(
        `AND ${alias}.decision_entity_type = snapshot.decision_entity_type`,
      );
      expect(
        lateral,
        `${alias} must pin decision_entity_id so the unique index is usable`,
      ).toContain(
        `AND ${alias}.decision_entity_id = snapshot.decision_entity_id`,
      );
    }
  });

  it("finds the episode boundary once per ad, not once per history row", () => {
    const episode = source.slice(
      source.indexOf("SELECT MIN(history.as_of_date) AS episode_started_at"),
      source.indexOf(") episode ON TRUE"),
    );
    const boundary = source.slice(
      source.indexOf("SELECT changed.as_of_date"),
      source.indexOf(") episode_boundary ON TRUE"),
    );
    // The anti-join is what made this quadratic. The equivalent closed form is
    // "the last differently-labelled day at or before the served day", which
    // one backward index scan answers in a single bounded lookup.
    expect(
      episode,
      "the episode lookup must not re-scan the timeline per history row",
    ).not.toContain("NOT EXISTS");
    expect(boundary).toContain("ORDER BY changed.as_of_date DESC");
    expect(boundary).toContain("LIMIT 1");
    expect(
      episode,
      "the episode lookup must be bounded below by the boundary it just found",
    ).toContain("history.as_of_date >= episode_boundary.as_of_date");
  });

  /**
   * The served currency is read once for the whole account, not once per ad.
   *
   * The per-ad LATERAL was sargable, but two indexes both offered its ordering
   * and the planner costed them 59.07 against 61.35. On one production account
   * it took the account-wide unique index and walked every ad of every day
   * backwards looking for one ad_id: 872,487 buffers and 8,910-11,214 ms for
   * this one column, past the 8,000 ms statement timeout on its own.
   *
   * DISTINCT ON is the same row and cannot drift on a tie, because
   * `meta_ad_daily_business_id_provider_account_id_date_ad_id_key` makes
   * (business, account, date, ad) unique -- date alone already decides. Keep
   * the ORDER BY in step with that key if it ever moves.
   */
  it("reads the account currency in one pass, not once per ad", () => {
    expect(source).toContain("WITH ad_daily AS MATERIALIZED (");
    expect(source).toContain("SELECT DISTINCT ON (daily.ad_id)");
    expect(source).toContain(
      "ORDER BY daily.ad_id, daily.date DESC, daily.updated_at DESC",
    );
    expect(
      source,
      "the currency must not be correlated back to a single snapshot row",
    ).not.toContain("AND daily.ad_id = snapshot.ad_id");
  });

  it("keeps the lifecycle lineage join the creative surfaces read from", () => {
    // Format, 28d CTR, 28d frequency and fatigue status come from the exact
    // lifecycle row the engine decided from. Dropping this join silently empties
    // the creative posture band and the media-kind badge.
    expect(source).toContain(
      "LEFT JOIN engine_v3_creative_lifecycle_daily lifecycle",
    );
    expect(source).toContain(
      "ON lifecycle.id = snapshot.creative_evidence_lifecycle_row_id",
    );
  });
});

/**
 * D081 C4 — the reader must carry the RAW persisted `kind_source`.
 *
 * These call the real `readMetaDecisionCampaignContextRows` through the mocked
 * `getDb()` path and then feed its rows into the real
 * `buildMetaDecisionsWorkspaceReadModel`, so nothing here reimplements the
 * mapping. A previous suite defined a local `map`/`trust` pair using raw
 * equality, which passed while the reader trimmed and fabricated.
 */
describe("D081 C4 — exact kind_source at the real reader boundary", () => {
  const contextRow = (over: Record<string, unknown> = {}) => ({
    campaign_id: "cmp_1",
    inferred_kind: "main",
    confidence_class: "high",
    confidence_score: 0.82,
    signal_scores_json: null,
    evidence_json: null,
    conflict_reasons_json: null,
    context_updated_at: "2026-07-09T10:00:00.000Z",
    context_as_of_date: "2026-07-09",
    resolver_version: "campaign-context-v2-account-scoped",
    kind_source: "system_inferred",
    ...over,
  });

  const readWith = (kindSource: unknown, over: Record<string, unknown> = {}) => {
    const rows = [contextRow({ kind_source: kindSource, ...over })];
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM engine_v3_campaign_context_daily")) return rows;
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);
    return readMetaDecisionCampaignContextRows({
      businessId: "biz_1",
      providerAccountId: "act_1",
      campaignIds: ["cmp_1"],
      snapshotAsOf: "2026-07-10",
    });
  };

  const NON_EXACT: Array<[string, unknown]> = [
    ["null", null],
    ["missing", undefined],
    ["empty", ""],
    ["leading space", " system_inferred"],
    ["trailing space", "system_inferred "],
    ["upper case", "SYSTEM_INFERRED"],
    ["unknown", "unknown"],
    ["legacy_label", "legacy_label"],
    ["user_override", "user_override"],
    ["manual", "manual"],
    ["operator", "operator"],
    ["batch_import", "batch_import"],
    ["bulk_apply_confirmed", "bulk_apply_confirmed"],
  ];

  it("serves the exact persisted source unchanged", async () => {
    const [row] = await readWith("system_inferred");
    expect(row?.source).toBe("system_inferred");
    expect(row?.kind).toBe("main");
  });

  it.each(NON_EXACT)("serves %s as unknown, never system_inferred", async (_label, value) => {
    const [row] = await readWith(value);
    expect(row?.source).toBe("unknown");
  });

  it("does not fabricate automatic provenance on the unresolved arm", async () => {
    // `inferred_kind` outside main/test/mixed takes the unresolved arm, which
    // previously synthesized `system_inferred` from the mode plus a context
    // timestamp.
    for (const [, value] of NON_EXACT) {
      const [row] = await readWith(value, { inferred_kind: null });
      expect(row?.kind).toBeNull();
      expect(row?.source, JSON.stringify(value)).toBe("unknown");
    }
    const [exact] = await readWith("system_inferred", { inferred_kind: null });
    expect(exact?.kind).toBeNull();
    expect(exact?.source).toBe("system_inferred");
  });

  it("only the exact persisted source can trust an action end to end", async () => {
    vi.mocked(isCampaignContextResolverAuthorityValidated).mockReturnValue(true);
    const trustFor = async (kindSource: unknown) => {
      const campaignContextRows = await readWith(kindSource);
      const model = buildMetaDecisionsWorkspaceReadModel({
        businessId: "biz_1",
        providerAccountId: "act_1",
        snapshotRows: [snapshot("creative_1", { label: "scale" })],
        identityRows: [identity("creative_1")],
        campaignContextRows,
        generatedAt: "2026-07-10T12:00:00.000Z",
      });
      return model.queue.sections.creative_rotation.items[0]?.classification
        .lifecycleRole?.trustedForAction;
    };

    // Every other gate is valid: high confidence and a validated resolver
    // version. Only the source differs.
    expect(await trustFor("system_inferred")).toBe(true);
    for (const [label, value] of NON_EXACT) {
      expect(await trustFor(value), label).toBe(false);
    }
    vi.mocked(isCampaignContextResolverAuthorityValidated).mockReset();
  });

  it("compares the raw value with no normalisation anywhere on the path", () => {
    const source = readFileSync("lib/meta/decisions-workspace-read-model.ts", "utf8");
    const helper = source.slice(
      source.indexOf("export function exactCampaignContextSource("),
      source.indexOf("export function exactCampaignContextSource(") + 260,
    );
    expect(helper).toContain('value === "system_inferred"');
    expect(helper).not.toMatch(/text\(|trim\(|toLowerCase|toUpperCase|normalize/);
    // Both arms go through the helper; neither compares or synthesizes itself.
    const uses = source.match(/source: exactCampaignContextSource\(row\.kind_source\)/g) ?? [];
    expect(uses).toHaveLength(2);
    expect(source).not.toMatch(/source:\s*\n?\s*mode === "automatic"/);
    expect(source).not.toContain('text(row.kind_source) === "system_inferred"');
  });
});

/*
 * THE ENGINE'S PREDICATE BLOCKERS MUST REACH THE SERVED ROW.
 *
 * `projectMetaDecisionSemantics` grew three held-verdict resolutions that name
 * WHICH readiness floor failed, all keyed on the engine's
 * `DecisionOutput.blockers`. The only production caller of that projector —
 * `projectCanonicalMetaDecisionPresentation` — did not pass the field, and
 * neither snapshot row type surfaced it, so on every served row the argument
 * was `[]` and all three were dead code reachable only from their own unit
 * tests: a false green. The blockers were persisted the whole time, in the
 * evaluation's `decision_output_json`.
 *
 * These cases drive the REAL read model from a source row, so they fail if any
 * link of persisted row -> `toDecisionOutput` -> presentation -> projector is
 * cut. Asserting the projector directly would not: it is the seam that was
 * broken, not the projector.
 */
describe("served held-verdict resolutions carry the engine's predicate blockers", () => {
  const heldScaleRow = (
    adId: string,
    overrides: Partial<MetaNativeDecisionSnapshotSourceRow>,
  ) =>
    nativeSnapshot(adId, {
      // A held verdict publishes the soft label and withholds the hard one.
      label: "keep",
      raw_label: "keep",
      pre_authority_label: "scale",
      blocked_action_type: "scale",
      authorized_action: null,
      badges: [
        {
          type: "scale_readiness_blocked",
          label: "Scale readiness blocked",
          severity: "info",
        },
        {
          type: "scale_calibration_thin",
          label: "Scale calibration thin",
          severity: "info",
        },
      ],
      ...overrides,
    });

  it("names the thin calibration sample instead of the generic hard-action evidence copy", () => {
    /*
      GC-051 shape from `scaleBenchmarkBlockers` in
      lib/creative-decision-engine/gates/ratio-zones.ts: the mature-ad sample is
      below its floor, and BOTH observed and threshold are numeric. The badge
      cannot carry this — `scaleReadinessBadges` stamps `scale_calibration_thin`
      for the missing-benchmark case too, which is why the row below carries the
      same badges as the next test and only the numbers differ.
    */
    const model = nativeModel([
      heldScaleRow("120000000000000911", {
        authority_blocker: "profile_hard_action_ineligible",
        predicate_blockers: [
          {
            predicate: "scale_account_benchmark_ready",
            observed: 19,
            threshold: 30,
            status: "missing",
            severity: "warning",
            reason:
              "account scale calibration thin (19 mature creatives; need 30+)",
          },
        ],
      }),
    ]);

    const item = model.queue.adCandidates?.items[0];
    expect(item?.classification.heldAction).toBe("scale");
    expect(item?.classification.resolution).toMatchObject({
      code: "complete_hard_action_evidence",
      owner: "system",
      label: "Scale Held — Calibration Sample Thin",
    });
    // The generic sentence this beats, which the served row used to get.
    expect(item?.classification.resolution?.label).not.toBe(
      "Complete Hard-Action Evidence",
    );
    expect(item?.classification.resolution?.nextStep).toContain(
      "only the account winner-calibration sample is below its floor",
    );
  });

  it("names the missing winner benchmark instead of asking integration to re-sync a current feed", () => {
    /*
      GC-052 shape: the SAME predicate name, with `observed: null` because the
      account has no winner purchase P50 at all. The engine holds it under
      `native_metrics_unavailable`, whose generic reading is "Refresh Decision
      Data" — owner `integration`, "restore a fresh, complete evidence window"
      — pointed at a feed that is already current.
    */
    const model = nativeModel([
      heldScaleRow("120000000000000912", {
        authority_blocker: "native_metrics_unavailable",
        predicate_blockers: [
          {
            predicate: "scale_account_benchmark_ready",
            observed: null,
            threshold: "positive winner purchase P50",
            status: "missing",
            severity: "warning",
            reason: "winner purchase benchmark unavailable",
          },
        ],
      }),
    ]);

    const item = model.queue.adCandidates?.items[0];
    expect(item?.classification.heldAction).toBe("scale");
    expect(item?.classification.resolution).toMatchObject({
      code: "complete_hard_action_evidence",
      category: "system",
      owner: "system",
      label: "Scale Held — Winner Benchmark Missing",
    });
    expect(item?.classification.resolution?.code).not.toBe(
      "refresh_decision_data",
    );
    expect(item?.classification.resolution?.owner).not.toBe("integration");
  });

  it("serves a Test-cohort held Refresh under its fatigue-evidence gap, not as a data repair", () => {
    /*
      THE COHORT REWRITE, END TO END.

      `finalizeDecision` in lib/creative-decision-engine/gates/types.ts rewrites
      a held Refresh's `blockedActionType` to "cut" on a Test campaign, so the
      served row's held action is "cut" while its blocker is still
      `refresh_ad_lifecycle_evidence`. The resolution branch used to require
      `heldAction === "refresh"`, so exactly this row — the one the branch was
      written for — fell through to `refresh_decision_data`: owner
      `integration`, told to restore a fresh evidence window before applying a
      Cut, while nothing about the window is stale.
    */
    const model = nativeModel(
      [
        nativeSnapshot("120000000000000913", {
          label: "keep",
          raw_label: "keep",
          pre_authority_label: "cut",
          label_transform: "test_cohort_refresh_to_cut",
          authority_blocker: "native_metrics_unavailable",
          blocked_action_type: "cut",
          authorized_action: null,
          badges: [
            {
              type: "lifecycle_unavailable",
              label: "Ad-level fatigue evidence unavailable",
              severity: "info",
            },
          ],
          predicate_blockers: [
            {
              predicate: "refresh_ad_lifecycle_evidence",
              observed: "unavailable",
              threshold: "fatigued",
              status: "missing",
              severity: "warning",
              reason:
                "no ad-level fatigue verdict exists for this entity, so creative wear cannot be confirmed",
            },
          ],
        }),
      ],
      { campaignContextRows: [context({ kind: "test" })] },
    );

    const item = model.queue.adCandidates?.items[0];
    // The cohort rewrite is visible: the held action really is a Cut.
    expect(item?.classification.heldAction).toBe("cut");
    expect(item?.classification.resolution).toMatchObject({
      code: "complete_hard_action_evidence",
      category: "system",
      owner: "system",
      // Named from the held action, so it matches the chip the operator sees.
      label: "Cut Held — Ad Fatigue Evidence Missing",
    });
    expect(item?.classification.resolution?.nextStep).toContain(
      "no ad-level fatigue verdict exists to confirm creative wear",
    );
    // The wrong answer this replaces, in full.
    expect(item?.classification.resolution?.code).not.toBe(
      "refresh_decision_data",
    );
    expect(item?.classification.resolution?.owner).not.toBe("integration");
    expect(item?.classification.resolution?.nextStep).not.toContain(
      "Restore a fresh, complete evidence window",
    );
  });

  it("falls back to the generic held-verdict copy when the row carries no blockers", () => {
    // Absence must stay honest. A snapshot whose evaluation row is missing (or
    // whose generation predates the blockers payload) gets the less specific
    // sentence, never a fabricated floor.
    const model = nativeModel([
      heldScaleRow("120000000000000914", {
        authority_blocker: "profile_hard_action_ineligible",
        predicate_blockers: null,
      }),
    ]);

    const item = model.queue.adCandidates?.items[0];
    expect(item?.classification.resolution).toMatchObject({
      code: "complete_hard_action_evidence",
      label: "Complete Hard-Action Evidence",
    });
  });

  it("projects the persisted blockers in both snapshot reads", async () => {
    // The column is the whole seam: if a query stops selecting it, every case
    // above still passes (they build source rows directly) while the served
    // row silently loses its specific resolution again.
    const rows = [nativeSnapshot("120000000000000911")];
    const nativeQuery = workspaceReadQuery({
      generationRows: [nativeGenerationForRows(rows)],
      nativeRows: rows,
    });
    vi.mocked(db.getDb).mockReturnValue({ query: nativeQuery } as never);
    await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      adIds: rows.map((row) => row.ad_id),
      generatedAt: "2026-07-13T12:00:00.000Z",
    });

    // No native generation at all, so the reader falls back to the legacy
    // creative-grain query.
    const legacyQuery = workspaceReadQuery({});
    vi.mocked(db.getDb).mockReturnValue({ query: legacyQuery } as never);
    await readMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      generatedAt: "2026-07-13T12:00:00.000Z",
    });

    const nativeSql = String(
      nativeQuery.mock.calls.find(
        ([sql]) =>
          String(sql).includes(
            "FROM engine_v3_ad_decision_snapshots_daily snapshot",
          ) && String(sql).includes("AS lineage_valid"),
      )?.[0],
    );
    const legacySql = String(
      legacyQuery.mock.calls.find(([sql]) =>
        String(sql).includes("scoped_history"),
      )?.[0],
    );
    expect(nativeSql).toContain(
      "evaluation.decision_output_json -> 'blockers' AS predicate_blockers",
    );
    expect(legacySql).toContain("AS predicate_blockers");
    expect(legacySql).toContain("FROM engine_v3_decision_evaluations evaluation");
  });
});
