import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  resolveEngineV3Flags,
  type EngineV3Flags,
} from "@/lib/creative-decision-engine/feature-flags";
import { canonicalSha256 } from "@/lib/creative-decision-engine/canonical-evaluation";
import { getDb } from "@/lib/db";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import { readMetaNativeCanonicalDecisionInventory } from "@/lib/meta/decisions-workspace-read-model";
import { GET } from "./route";

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/creative-decision-engine/feature-flags", () => ({
  resolveEngineV3Flags: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/meta/decisions-workspace-read-model", () => ({
  readMetaNativeCanonicalDecisionInventory: vi.fn(),
}));

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const PROVIDER_REF_ID = "00000000-0000-4000-8000-000000000002";
const JOB_RUN_ID = "00000000-0000-4000-8000-000000000003";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000004";
const EVALUATION_ID = "00000000-0000-4000-8000-000000000005";
const CONTEXT_ID = "00000000-0000-4000-8000-000000000006";
const EVALUATION_CONTRACT_VERSION =
  "engine-v3-native-ad-evaluation.v1";
const ENGINE_VERSION = "native-current";
const SCOPE_JSON = { type: "account", id: "act_1" };
const ACCOUNT_PROFILE_JSON = { scope: SCOPE_JSON };
const DATA_HEALTH_JSON = { worstTier: "none" };
const FLAGS_JSON = { shadowOnly: true };
const CONTEXT_JSON = {
  contractVersion: EVALUATION_CONTRACT_VERSION,
  envelopeType: "context",
  engineVersion: ENGINE_VERSION,
  scope: SCOPE_JSON,
  accountProfile: ACCOUNT_PROFILE_JSON,
  dataHealth: DATA_HEALTH_JSON,
  flags: FLAGS_JSON,
};
const CONTEXT_HASH = canonicalSha256(CONTEXT_JSON);
const CREATIVE_INPUT_JSON = {
  creativeId: "creative-1",
  decisionEntityType: "ad",
  decisionEntityId: "ad-1",
  adId: "ad-1",
  providerAccountId: "act_1",
  businessId: BUSINESS_ID,
  spend: 500,
};
const CAMPAIGN_CONTEXT_JSON = { kind: "main" };
const PRIOR_HYSTERESIS_JSON = { prior: null };
const DECISION_OUTPUT_JSON = {
  creativeId: "creative-1",
  decisionEntityType: "ad",
  decisionEntityId: "ad-1",
  adId: "ad-1",
  providerAccountId: "act_1",
  label: "keep",
  blockedActionType: "cut",
};
const INPUT_HASH = canonicalSha256({
  contractVersion: EVALUATION_CONTRACT_VERSION,
  envelopeType: "input",
  engineVersion: ENGINE_VERSION,
  contextHash: CONTEXT_HASH,
  creativeInput: CREATIVE_INPUT_JSON,
  campaignContext: CAMPAIGN_CONTEXT_JSON,
  priorHysteresis: PRIOR_HYSTERESIS_JSON,
  decisionIdentity: {
    decisionEntityType: "ad",
    decisionEntityId: "ad-1",
    adId: "ad-1",
    providerAccountId: "act_1",
    providerAccountRefId: PROVIDER_REF_ID,
    creativeGroupingId: "creative-1",
  },
});
const DECISION_HASH = canonicalSha256({
  contractVersion: EVALUATION_CONTRACT_VERSION,
  envelopeType: "decision",
  engineVersion: ENGINE_VERSION,
  inputHash: INPUT_HASH,
  decision: DECISION_OUTPUT_JSON,
  rawLabel: "cut",
  publishedLabel: "keep",
  hysteresisSuppressed: false,
});

function flags(overrides: Partial<EngineV3Flags> = {}): EngineV3Flags {
  return {
    businessId: BUSINESS_ID,
    enabled: true,
    surfaceVisible: true,
    shadowOnly: true,
    presetOverride: null,
    source: {
      enabled: "env",
      surfaceVisible: "env",
      shadowOnly: "env",
      presetOverride: null,
    },
    envDefaults: {
      enabled: true,
      surfaceVisible: true,
      shadowOnly: true,
    },
    ...overrides,
  };
}

function canonicalDecision(
  overrides: Partial<MetaCanonicalDecision> = {},
): MetaCanonicalDecision {
  return {
    decisionId: "decision-ad-1",
    episodeId: "episode-ad-1",
    episodeStartedAt: "2026-07-16",
    providerAccountId: "act_1",
    identityGrain: "ad",
    sourceSnapshotId: SNAPSHOT_ID,
    sourceAuthority: {
      status: "native_exact",
      actionEligible: false,
      reviewOnlyReason: "pending_transition",
      snapshotId: SNAPSHOT_ID,
      evaluationId: EVALUATION_ID,
      inputHash: INPUT_HASH,
      decisionHash: DECISION_HASH,
      providerAccountRefId: PROVIDER_REF_ID,
      engineVersion: "native-current",
      realAdId: "ad-1",
      authorizedAction: null,
      jobRunId: JOB_RUN_ID,
    },
    sourceDecision: {
      label: "keep",
      preAuthorityLabel: "cut",
      authorityBlocker: "pending_transition",
      rawLabel: "cut",
      reason: "Persisted Cut is held for epoch confirmation.",
      confidence: 91,
      confidenceBand: "high",
      truthSource: "commercial_truth",
      engineVersion: "native-current",
      snapshotAsOf: "2026-07-16",
      computedAt: "2026-07-16T03:05:00.000Z",
      badges: ["pending_transition"],
      provenance: {} as never,
    },
    parentChain: {
      account: { id: "act_1", name: null },
      campaign: { id: "campaign-1", name: "Campaign" },
      adset: { id: "adset-1", name: "Ad set" },
      ad: { id: "ad-1", name: "Ad one" },
      creative: { id: "creative-1", name: "Creative one" },
      provenance: {} as never,
    },
    identityResolution: {
      basis: "native_ad_exact",
      candidateAdCount: 1,
      metricsEquivalent: true,
      adActionEligible: true,
    },
    classification: {
      overlayVersion: "meta-decisions-classification-overlay.v1",
      queueSection: "creative_rotation",
      lifecycleRole: { value: "main" } as never,
      assessment: {} as never,
      decisionState: "blocked",
      heldAction: "cut",
      legacyBuyerAction: "cut",
      buyerAction: null,
      buyerLabel: "Cut · Held",
      executionAction: null,
      resolution: null,
      blockers: [],
      provenance: {} as never,
    },
    history: {
      events: { status: "available", reason: null, preCapCount: 0, items: [] },
      outcomes: { status: "unavailable", reason: "not_accrued", items: [] },
      responses: {
        status: "available",
        reason: null,
        items: [
          {
            id: "response-1",
            observationStatus: "observed_no_response",
            responseType: "ignored",
            detectedAt: "2026-07-16T10:00:00.000Z",
            responseCutoff: "2026-07-16T09:00:00.000Z",
          },
        ],
      },
      providerWrites: { status: "unavailable", reason: "not_observed" },
    },
    metrics: {
      spend: 500,
      purchases: 2,
      roas: 0.8,
      recent7dRoas: 0.7,
      effectiveTargetRoas: 2.2,
      ratioToTarget: 0.36,
      currency: "USD",
      attribution: "meta_attributed",
      provenance: {} as never,
    },
    ...overrides,
  } as unknown as MetaCanonicalDecision;
}

function generation(items = [canonicalDecision()]) {
  return {
    status: "available" as const,
    generation: {
      jobRunId: JOB_RUN_ID,
      asOfDate: "2026-07-16",
      providerAccountRefId: PROVIDER_REF_ID,
      manifestHash: "a".repeat(64),
      expectedAdCount: items.length,
    },
    items,
    unavailableReason: null,
  };
}

function evidenceRow(overrides: Record<string, unknown> = {}) {
  return {
    snapshot_id: SNAPSHOT_ID,
    evaluation_id: EVALUATION_ID,
    context_id: CONTEXT_ID,
    job_run_id: JOB_RUN_ID,
    provider_account_ref_id: PROVIDER_REF_ID,
    provider_account_id: "act_1",
    ad_id: "ad-1",
    snapshot_decision_entity_type: "ad",
    snapshot_decision_entity_id: "ad-1",
    evaluation_decision_entity_type: "ad",
    evaluation_decision_entity_id: "ad-1",
    snapshot_creative_id: "creative-1",
    evaluation_creative_id: "creative-1",
    snapshot_raw_label: "cut",
    snapshot_published_label: "keep",
    evaluation_raw_label: "cut",
    evaluation_hysteresis_suppressed: false,
    as_of_date: "2026-07-16",
    engine_version: ENGINE_VERSION,
    scope_type: "account",
    scope_id: "act_1",
    snapshot_input_hash: INPUT_HASH,
    snapshot_decision_hash: DECISION_HASH,
    evaluation_input_hash: INPUT_HASH,
    evaluation_decision_hash: DECISION_HASH,
    evaluation_contract_version: EVALUATION_CONTRACT_VERSION,
    evaluation_evaluated_at: "2026-07-16T03:04:00.000Z",
    context_contract_version: EVALUATION_CONTRACT_VERSION,
    context_hash: CONTEXT_HASH,
    context_evaluated_at: "2026-07-16T03:03:00.000Z",
    creative_input_json: CREATIVE_INPUT_JSON,
    campaign_context_json: CAMPAIGN_CONTEXT_JSON,
    prior_hysteresis_json: PRIOR_HYSTERESIS_JSON,
    decision_output_json: DECISION_OUTPUT_JSON,
    context_json: CONTEXT_JSON,
    account_profile_json: ACCOUNT_PROFILE_JSON,
    data_health_json: DATA_HEALTH_JSON,
    flags_json: FLAGS_JSON,
    ...overrides,
  };
}

function mockAccess() {
  vi.mocked(requireBusinessAccess).mockResolvedValue({
    session: { user: { id: "user-1" } } as never,
    membership: {
      id: "membership-1",
      userId: "user-1",
      businessId: BUSINESS_ID,
      role: "guest",
      status: "active",
      joinedAt: "2026-07-01T00:00:00.000Z",
    },
  });
}

const query = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockAccess();
  vi.mocked(resolveEngineV3Flags).mockResolvedValue(flags());
  vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue(
    generation(),
  );
  query.mockResolvedValue([evidenceRow()]);
  vi.mocked(getDb).mockReturnValue({ query } as never);
});

describe("GET /api/creatives/decision-engine-v3/evidence", () => {
  it("requires business, provider account, and exact Ad identity", async () => {
    const missingBusiness = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3/evidence?providerAccountId=act_1&adId=ad-1",
      ),
    );
    const missingAccount = await GET(
      new NextRequest(
        `http://localhost/api/creatives/decision-engine-v3/evidence?businessId=${BUSINESS_ID}&adId=ad-1`,
      ),
    );
    const missingAd = await GET(
      new NextRequest(
        `http://localhost/api/creatives/decision-engine-v3/evidence?businessId=${BUSINESS_ID}&providerAccountId=act_1`,
      ),
    );

    expect(missingBusiness.status).toBe(400);
    expect(missingAccount.status).toBe(400);
    expect(missingAd.status).toBe(400);
    expect(await missingAd.json()).toEqual({ error: "adId required" });
  });

  it("serves persisted snapshot/evaluation/context lineage without recomputation", async () => {
    const response = await GET(
      new NextRequest(
        `http://localhost/api/creatives/decision-engine-v3/evidence?businessId=${BUSINESS_ID}&providerAccountId=act_1&adId=ad-1&asOf=2026-07-16`,
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: "available",
      contractVersion: "decision-engine-v3-native-ad-evidence.v1",
      providerAccountId: "act_1",
      adId: "ad-1",
      creativeId: "creative-1",
      lineage: {
        status: "verified",
        jobRunId: JOB_RUN_ID,
        snapshot: {
          id: SNAPSHOT_ID,
          inputHash: INPUT_HASH,
          decisionHash: DECISION_HASH,
        },
        evaluation: { id: EVALUATION_ID, contextId: CONTEXT_ID },
        context: { id: CONTEXT_ID, contextHash: CONTEXT_HASH },
      },
      persistedEvidence: {
        creativeInput: { creativeId: "creative-1", spend: 500 },
        decisionOutput: { label: "keep", blockedActionType: "cut" },
      },
    });
    expect(payload.decision.classification).toMatchObject({
      decisionState: "blocked",
      heldAction: "cut",
      buyerAction: null,
      buyerLabel: "Cut · Held",
    });
    expect(readMetaNativeCanonicalDecisionInventory).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      asOfDate: "2026-07-16",
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("engine_v3_ad_decision_evaluation_contexts"),
      [
        BUSINESS_ID,
        "act_1",
        PROVIDER_REF_ID,
        "ad-1",
        SNAPSHOT_ID,
        EVALUATION_ID,
        JOB_RUN_ID,
        "2026-07-16",
        "native-current",
        INPUT_HASH,
        DECISION_HASH,
      ],
    );
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "evaluation.creative_id IS NOT DISTINCT FROM snapshot.creative_id",
    );
  });

  it("fails closed on unavailable generation and never queries legacy evidence", async () => {
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue({
      status: "unavailable",
      generation: null,
      items: [],
      unavailableReason: "native_account_receipt_cardinality_invalid",
    });
    const response = await GET(
      new NextRequest(
        `http://localhost/api/creatives/decision-engine-v3/evidence?businessId=${BUSINESS_ID}&providerAccountId=act_1&adId=ad-1`,
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: "native_account_receipt_cardinality_invalid",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed on cross-account canonical identity", async () => {
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue(
      generation([canonicalDecision({ providerAccountId: "act_2" })]),
    );
    const response = await GET(
      new NextRequest(
        `http://localhost/api/creatives/decision-engine-v3/evidence?businessId=${BUSINESS_ID}&providerAccountId=act_1&adId=ad-1`,
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: "native_exact_ad_identity_or_lineage_invalid",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects duplicate or contradictory persisted lineage rows", async () => {
    query.mockResolvedValue([evidenceRow(), evidenceRow()]);
    const duplicate = await GET(
      new NextRequest(
        `http://localhost/api/creatives/decision-engine-v3/evidence?businessId=${BUSINESS_ID}&providerAccountId=act_1&adId=ad-1`,
      ),
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      reason: "native_persisted_evidence_cardinality_invalid",
    });

    query.mockResolvedValue([evidenceRow({ context_hash: "invalid" })]);
    const invalid = await GET(
      new NextRequest(
        `http://localhost/api/creatives/decision-engine-v3/evidence?businessId=${BUSINESS_ID}&providerAccountId=act_1&adId=ad-1`,
      ),
    );
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toMatchObject({
      reason: "native_persisted_evidence_lineage_invalid",
    });
  });

  it("rejects a tampered canonical creative-input envelope", async () => {
    query.mockResolvedValue([
      evidenceRow({
        creative_input_json: { ...CREATIVE_INPUT_JSON, spend: 501 },
      }),
    ]);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/creatives/decision-engine-v3/evidence?businessId=${BUSINESS_ID}&providerAccountId=act_1&adId=ad-1`,
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: "native_persisted_evidence_lineage_invalid",
    });
  });

  it("rejects a tampered canonical decision envelope", async () => {
    query.mockResolvedValue([
      evidenceRow({
        decision_output_json: { ...DECISION_OUTPUT_JSON, reason: "tampered" },
      }),
    ]);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/creatives/decision-engine-v3/evidence?businessId=${BUSINESS_ID}&providerAccountId=act_1&adId=ad-1`,
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: "native_persisted_evidence_lineage_invalid",
    });
  });

  it("rejects mismatched nullable creative grouping lineage", async () => {
    query.mockResolvedValue([
      evidenceRow({ evaluation_creative_id: "creative-other" }),
    ]);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/creatives/decision-engine-v3/evidence?businessId=${BUSINESS_ID}&providerAccountId=act_1&adId=ad-1`,
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: "native_persisted_evidence_lineage_invalid",
    });
  });

  it("preserves access and disabled gates", async () => {
    vi.mocked(requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "auth_error" }, { status: 401 }),
    });
    const denied = await GET(
      new NextRequest(
        `http://localhost/api/creatives/decision-engine-v3/evidence?businessId=${BUSINESS_ID}&providerAccountId=act_1&adId=ad-1`,
      ),
    );
    expect(denied.status).toBe(401);

    mockAccess();
    vi.mocked(resolveEngineV3Flags).mockResolvedValue(flags({ enabled: false }));
    const disabled = await GET(
      new NextRequest(
        `http://localhost/api/creatives/decision-engine-v3/evidence?businessId=${BUSINESS_ID}&providerAccountId=act_1&adId=ad-1`,
      ),
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ status: "disabled" });
  });

  it("contains no request-time decision or profile calculator", () => {
    const source = readFileSync(
      "app/api/creatives/decision-engine-v3/evidence/route.ts",
      "utf8",
    );
    expect(source).not.toMatch(/\bdecideCreative\b/);
    expect(source).not.toMatch(/\bresolveAccountDecisionProfile\b/);
    expect(source).not.toMatch(/\bresolveDataSource\b/);
  });
});
