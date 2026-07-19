import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  resolveEngineV3Flags,
  type EngineV3Flags,
} from "@/lib/creative-decision-engine/feature-flags";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import { readMetaNativeCanonicalDecisionInventory } from "@/lib/meta/decisions-workspace-read-model";
import { GET } from "./route";

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/creative-decision-engine/feature-flags", () => ({
  resolveEngineV3Flags: vi.fn(),
}));
vi.mock("@/lib/meta/decisions-workspace-read-model", () => ({
  readMetaNativeCanonicalDecisionInventory: vi.fn(),
}));

const INPUT_HASH = "1".repeat(64);
const DECISION_HASH = "2".repeat(64);

function flags(overrides: Partial<EngineV3Flags> = {}): EngineV3Flags {
  return {
    businessId: "biz-1",
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

function canonicalDecision(input: {
  adId: string;
  creativeId?: string | null;
  providerAccountId?: string;
  campaignId?: string;
}): MetaCanonicalDecision {
  const providerAccountId = input.providerAccountId ?? "act_1";
  return {
    decisionId: `decision-${input.adId}`,
    episodeId: `episode-${input.adId}`,
    episodeStartedAt: "2026-07-16",
    providerAccountId,
    identityGrain: "ad",
    sourceSnapshotId: `snapshot-${input.adId}`,
    sourceAuthority: {
      status: "native_exact",
      actionEligible: true,
      reviewOnlyReason: null,
      snapshotId: `snapshot-${input.adId}`,
      evaluationId: `evaluation-${input.adId}`,
      inputHash: INPUT_HASH,
      decisionHash: DECISION_HASH,
      providerAccountRefId: "provider-ref-1",
      engineVersion: "native-current",
      realAdId: input.adId,
      authorizedAction: "cut",
      jobRunId: "job-run-1",
    },
    sourceDecision: {
      label: "cut",
      preAuthorityLabel: "cut",
      authorityBlocker: null,
      rawLabel: "cut",
      reason: `Persisted exact-Ad verdict for ${input.adId}`,
      confidence: 91,
      confidenceBand: "high",
      truthSource: "commercial_truth",
      engineVersion: "native-current",
      snapshotAsOf: "2026-07-16",
      computedAt: "2026-07-16T03:05:00.000Z",
      badges: ["below_breakeven"],
      provenance: {} as never,
    },
    parentChain: {
      account: { id: providerAccountId, name: null },
      campaign: { id: input.campaignId ?? "campaign-1", name: "Campaign" },
      adset: { id: "adset-1", name: "Ad set" },
      ad: { id: input.adId, name: `Ad ${input.adId}` },
      creative:
        input.creativeId === null
          ? null
          : { id: input.creativeId ?? "creative-1", name: "Creative" },
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
      decisionState: "act",
      heldAction: null,
      legacyBuyerAction: "cut",
      buyerAction: "cut",
      buyerLabel: "Cut",
      executionAction: null,
      resolution: null,
      blockers: [],
      provenance: {} as never,
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
  } as unknown as MetaCanonicalDecision;
}

function inventory(items: MetaCanonicalDecision[]) {
  return {
    status: "available" as const,
    generation: {
      jobRunId: "job-run-1",
      asOfDate: "2026-07-16",
      providerAccountRefId: "provider-ref-1",
      manifestHash: "a".repeat(64),
      expectedAdCount: items.length,
    },
    items,
    unavailableReason: null,
  };
}

function mockAccess() {
  vi.mocked(requireBusinessAccess).mockResolvedValue({
    session: { user: { id: "user-1" } } as never,
    membership: {
      id: "membership-1",
      userId: "user-1",
      businessId: "biz-1",
      role: "guest",
      status: "active",
      joinedAt: "2026-07-01T00:00:00.000Z",
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAccess();
  vi.mocked(resolveEngineV3Flags).mockResolvedValue(flags());
  vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue(
    inventory([canonicalDecision({ adId: "ad-1" })]),
  );
});

describe("GET /api/creatives/decision-engine-v3", () => {
  it("requires exact business and provider-account scope", async () => {
    const missingBusiness = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?providerAccountId=act_1",
      ),
    );
    const missingAccount = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1",
      ),
    );

    expect(missingBusiness.status).toBe(400);
    expect(missingAccount.status).toBe(400);
    expect(await missingAccount.json()).toEqual({
      error: "providerAccountId required",
    });
    expect(requireBusinessAccess).not.toHaveBeenCalled();
  });

  it("serves persisted exact-Ad inventory and a one-to-one review projection", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1&providerAccountId=act_1&creativeIds=creative-1&asOf=2026-07-16",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: "available",
      contractVersion: "decision-engine-v3-native-ad-serving.v1",
      providerAccountId: "act_1",
      asOf: "2026-07-16",
      dataSource: "native_persisted_generation",
      inventory: {
        preFilterCount: 1,
        selectedCount: 1,
        identityGrain: "ad",
      },
      compatibility: {
        authority: "review_only",
        omittedAmbiguousCreativeCount: 0,
      },
    });
    expect(payload.inventory.items[0].parentChain.ad.id).toBe("ad-1");
    expect(payload.decisions).toEqual([
      expect.objectContaining({
        creativeId: "creative-1",
        label: "cut",
        reason: "Persisted exact-Ad verdict for ad-1",
      }),
    ]);
    expect(readMetaNativeCanonicalDecisionInventory).toHaveBeenCalledWith({
      businessId: "biz-1",
      providerAccountId: "act_1",
      asOfDate: "2026-07-16",
    });
  });

  it("retains every Ad sharing a creative and withholds representative selection", async () => {
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue(
      inventory([
        canonicalDecision({ adId: "ad-1", creativeId: "creative-shared" }),
        canonicalDecision({ adId: "ad-2", creativeId: "creative-shared" }),
      ]),
    );
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1&providerAccountId=act_1&creativeIds=creative-shared",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.inventory.items.map((item: MetaCanonicalDecision) => item.parentChain.ad?.id)).toEqual([
      "ad-1",
      "ad-2",
    ]);
    expect(payload.decisions).toEqual([]);
    expect(payload.compatibility.omittedAmbiguousCreativeCount).toBe(1);
  });

  it("omits a creative review projection when required metrics are non-finite", async () => {
    const decision = canonicalDecision({ adId: "ad-1" });
    decision.metrics = { ...decision.metrics, spend: null };
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue(
      inventory([decision]),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1&providerAccountId=act_1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.inventory.items).toHaveLength(1);
    expect(payload.decisions).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain("NaN");
  });

  it("fails closed on a cross-account or malformed canonical projection", async () => {
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue(
      inventory([
        canonicalDecision({ adId: "ad-1", providerAccountId: "act_2" }),
      ]),
    );
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1&providerAccountId=act_1",
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "unavailable",
      reason: "native_canonical_serving_projection_invalid",
    });
  });

  it("does not borrow or recompute a decision when the generation is unavailable", async () => {
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue({
      status: "unavailable",
      generation: null,
      items: [],
      unavailableReason: "native_account_receipt_cardinality_invalid",
    });
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1&providerAccountId=act_1",
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "unavailable",
      reason: "native_account_receipt_cardinality_invalid",
    });
  });

  it("preserves access and feature-flag fail-closed gates", async () => {
    vi.mocked(requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "auth_error" }, { status: 403 }),
    });
    const denied = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1&providerAccountId=act_1",
      ),
    );
    expect(denied.status).toBe(403);

    mockAccess();
    vi.mocked(resolveEngineV3Flags).mockResolvedValue(flags({ enabled: false }));
    const disabled = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1&providerAccountId=act_1",
      ),
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      status: "disabled",
      reason: "engine_v3_disabled_for_business",
    });
  });

  it("contains no request-time resolver or data-source path", () => {
    const source = readFileSync(
      "app/api/creatives/decision-engine-v3/route.ts",
      "utf8",
    );
    expect(source).not.toMatch(/\bdecideCreative\b/);
    expect(source).not.toMatch(/\bresolveAccountDecisionProfile\b/);
    expect(source).not.toMatch(/\bresolveDataSource\b/);
  });
});
