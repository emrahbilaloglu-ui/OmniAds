/**
 * The served action census must be able to report an executable row.
 *
 * A 24-cell availability matrix run through the real producer, the real
 * retained snapshot and the real served route measured
 * `queue.actionStates = {executableBid: 0, …, reviewOnly: 7}` in EVERY cell —
 * including the two cells where the card's own
 * `operatorApply {action:"bid", bidAmountMinor:1320}` was POSTed to the
 * provider double and confirmed by read-back. The counters were keyed on
 * `rec.actionKind`, and no writer in this tree can put an `execute_*` value
 * there, so the three executable counters were structurally dead and
 * `reviewOnly` was always the row total.
 *
 * These cases pin both halves: the census counts what the row actually offers,
 * and the reason it must — `serverActionKindForRec`, the only function that
 * stamps `actionKind` from a recommendation, cannot produce an `execute_*`
 * value for any input. Neither case asserts an action COUNT: the fixture rows
 * carry the same lane placement before and after, and only the census moves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  metaLanePayload,
  metaPulse,
  metaRec,
} from "@/components/meta/redesign/test-fixtures";
import {
  serverActionKindForRec,
  serverOperatorApplyForRec,
} from "@/lib/meta/rec-presentation";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

const accessMock = vi.hoisted(() => ({ requireBusinessAccess: vi.fn() }));
const reviewerMock = vi.hoisted(() => ({ isReviewerEmail: vi.fn() }));
const dbMock = vi.hoisted(() => ({
  getDb: vi.fn(),
  getDbRuntimeDiagnostics: vi.fn(() => ({ pool: {}, counters: {} })),
}));
const assignmentsMock = vi.hoisted(() => ({
  getProviderAccountAssignments: vi.fn(),
}));
const readModelMock = vi.hoisted(() => ({
  buildUnavailableMetaDecisionsWorkspaceReadModel: vi.fn(),
  applyMetaExecutionGovernanceToReadModel: vi.fn(),
  readMetaDecisionCampaignContextRows: vi.fn(),
  readMetaDecisionsWorkspaceReadModel: vi.fn(),
}));
const governanceMock = vi.hoisted(() => ({
  readEffectiveMetaWriteGovernance: vi.fn(),
}));
const pipelineHealthMock = vi.hoisted(() => ({
  readMetaDecisionPipelineOperationalHealth: vi.fn(),
  buildMetaDecisionPipelineHealth: vi.fn(),
}));
const metaApiMock = vi.hoisted(() => ({
  resolveMetaCredentials: vi.fn(),
  fetchMetaActiveAdConfigsReceipt: vi.fn(),
}));
const upstreamRouteMock = vi.hoisted(() => ({
  accountPulseGet: vi.fn(),
  laneClassificationGet: vi.fn(),
}));
const commercialTargetsMock = vi.hoisted(() => ({
  hasMetaHardActionAnchor: vi.fn(),
  readMetaCommercialTargets: vi.fn(),
}));
const anchorMock = vi.hoisted(() => ({
  resolveAccountDecisionProfile: vi.fn(),
}));
const shopifyAovMock = vi.hoisted(() => ({
  resolveObservedShopifyAov: vi.fn(),
}));
const targetPackMock = vi.hoisted(() => ({ getBusinessTargetPack: vi.fn() }));

vi.mock("@/app/api/meta/account-pulse/route", () => ({
  GET: upstreamRouteMock.accountPulseGet,
}));
vi.mock("@/app/api/meta/lane-classify/route", () => ({
  GET: upstreamRouteMock.laneClassificationGet,
}));
vi.mock("@/lib/api/meta", () => ({
  resolveMetaCredentials: metaApiMock.resolveMetaCredentials,
  fetchMetaActiveAdConfigsReceipt: metaApiMock.fetchMetaActiveAdConfigsReceipt,
}));
vi.mock("@/lib/meta/business-data-posture", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta/business-data-posture")>();
  return { ...actual, readMetaBusinessDataPosture: vi.fn(async () => "live" as const) };
});
vi.mock("@/lib/access", () => ({
  requireBusinessAccess: accessMock.requireBusinessAccess,
}));
vi.mock("@/lib/reviewer-access", () => ({
  isReviewerEmail: reviewerMock.isReviewerEmail,
}));
vi.mock("@/lib/db", () => ({
  getDb: dbMock.getDb,
  getDbRuntimeDiagnostics: dbMock.getDbRuntimeDiagnostics,
}));
vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: assignmentsMock.getProviderAccountAssignments,
}));
vi.mock("@/lib/meta/decisions-workspace-read-model", () => ({
  resolveProvisionalCampaignKind: vi.fn(() => "main"),
  buildUnavailableMetaDecisionsWorkspaceReadModel:
    readModelMock.buildUnavailableMetaDecisionsWorkspaceReadModel,
  applyMetaExecutionGovernanceToReadModel:
    readModelMock.applyMetaExecutionGovernanceToReadModel,
  readMetaDecisionCampaignContextRows:
    readModelMock.readMetaDecisionCampaignContextRows,
  readMetaDecisionsWorkspaceReadModel:
    readModelMock.readMetaDecisionsWorkspaceReadModel,
}));
vi.mock("@/lib/meta/automation-control-plane", () => ({
  readEffectiveMetaWriteGovernance:
    governanceMock.readEffectiveMetaWriteGovernance,
}));
vi.mock("@/lib/meta/decision-pipeline-health", () => ({
  readMetaDecisionPipelineOperationalHealth:
    pipelineHealthMock.readMetaDecisionPipelineOperationalHealth,
  buildMetaDecisionPipelineHealth:
    pipelineHealthMock.buildMetaDecisionPipelineHealth,
}));
vi.mock("@/lib/meta/commercial-targets", () => ({
  hasMetaHardActionAnchor: commercialTargetsMock.hasMetaHardActionAnchor,
  readMetaCommercialTargets: commercialTargetsMock.readMetaCommercialTargets,
}));
vi.mock("@/lib/creative-decision-engine/account-decision-profile", async (
  importOriginal,
) => {
  const actual = await importOriginal<
    typeof import("@/lib/creative-decision-engine/account-decision-profile")
  >();
  return {
    ...actual,
    resolveAccountDecisionProfile: anchorMock.resolveAccountDecisionProfile,
  };
});
vi.mock("@/lib/creative-decision-engine/shopify-aov-source", async (
  importOriginal,
) => {
  const actual = await importOriginal<
    typeof import("@/lib/creative-decision-engine/shopify-aov-source")
  >();
  return {
    ...actual,
    resolveObservedShopifyAov: shopifyAovMock.resolveObservedShopifyAov,
  };
});
vi.mock("@/lib/creative-decision-engine/data-source", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/creative-decision-engine/data-source")
  >();
  class StubWarehouseDataSource {
    getBusinessTargetPack = targetPackMock.getBusinessTargetPack;
  }
  return { ...actual, WarehouseDataSource: StubWarehouseDataSource };
});

const { GET } = await import("@/app/api/meta/decisions-workspace/route");

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function healthyPipelineHealth() {
  return {
    contractVersion: "meta-decision-pipeline-health.v1" as const,
    evaluatedAt: "2026-09-04T12:00:00.000Z",
    overall: "healthy" as const,
    executionReady: true,
    blockers: [],
    syncActivity: {
      status: "fresh" as const,
      latestAt: "2026-09-04T11:55:00.000Z",
      ageMinutes: 5,
      maxAgeMinutes: 60,
      latestJobStatus: "succeeded",
      latestRunStatus: "succeeded",
      reason: null,
    },
    warehouse: {
      status: "fresh" as const,
      latestFinalizedDate: "2026-09-03",
      expectedFinalizedDate: "2026-09-03",
      lagDays: 0,
      accountTimeZone: "UTC",
      reason: null,
    },
    admission: {
      status: "fresh" as const,
      allowed: true,
      reason: "ready",
      offender: null,
      evaluatedAt: "2026-09-04T12:00:00.000Z",
    },
    decisionGeneration: {
      status: "fresh" as const,
      computedAt: "2026-09-04T11:50:00.000Z",
      ageHours: 1 / 6,
      maxAgeHours: 12,
      engineVersion: "v3-ad-current",
      reason: null,
    },
    manifest: {
      status: "fresh" as const,
      authority: "native_ad",
      jobRunId: "job_1",
      manifestHash: "a".repeat(64),
      expectedAdCount: 1,
      reason: null,
    },
  };
}

/**
 * A row shaped the way the shipped producer actually emits one.
 *
 * `metaRec` runs its input through the real `annotateMetaRecPresentation`, so
 * `actionKind`, `operatorApply` and `primaryActionLabel` are stamped by the
 * shipped functions rather than typed in here. That matters: hand-writing
 * `actionKind: "execute_pause"` — which existing route cases do — asserts a
 * value no producer can emit, and is exactly how a dead counter stayed green.
 */
function cappedAdsetBidRow(): MetaRecommendation {
  return metaRec({
    id: "rec_bid_1320",
    level: "adset",
    campaignId: "9000000000101",
    adsetId: "9000000000201",
    adsetName: "Broad prospecting",
    type: "scenario_e1_frequency_fatigue",
    decisionState: "test",
    // The shipped bid-intent contract, exactly as the producer writes it:
    // `proposedMinorUnits` and `bidAmountMinor` must agree, or
    // `executableBidIntentMinorUnits` refuses (two numbers for one write is
    // not a number).
    targetValue: {
      contractVersion: "meta.bid-intent.v1",
      authorityStatus: "authorised",
      blockerCodes: [],
      currentMinorUnits: 1200,
      proposedMinorUnits: 1320,
      bidAmountMinor: 1320,
      currency: "USD",
      sizingPolicyVersion: "meta.bid-sizing.v1",
    } as unknown as MetaRecommendation["targetValue"],
  });
}

function pauseCandidateRow(): MetaRecommendation {
  return metaRec({
    id: "rec_pause",
    level: "adset",
    campaignId: "9000000000102",
    adsetId: "9000000000202",
    type: "scenario_a5_post_learning_underperformer",
    decisionState: "act",
    proposedAction: { kind: "pause" },
  });
}

function stateRow(id: string): MetaRecommendation {
  return metaRec({
    id,
    kind: "state",
    level: "adset",
    campaignId: "9000000000101",
    adsetId: "9000000000201",
    type: "adset_state",
    decisionState: "watch",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  accessMock.requireBusinessAccess.mockResolvedValue({
    session: {
      sessionId: "sess_1",
      activeBusinessId: "biz_1",
      expiresAt: "2026-09-05T00:00:00.000Z",
      user: {
        id: "user_1",
        name: "Operator",
        email: "operator@example.com",
        avatar: null,
        language: "en",
      },
    },
    membership: {
      id: "mem_1",
      userId: "user_1",
      businessId: "biz_1",
      role: "collaborator",
      status: "active",
      joinedAt: "2026-09-01T00:00:00.000Z",
    },
  });
  reviewerMock.isReviewerEmail.mockReturnValue(false);
  assignmentsMock.getProviderAccountAssignments.mockResolvedValue({
    account_ids: ["act_9000000000001"],
  });
  metaApiMock.resolveMetaCredentials.mockResolvedValue(null);
  metaApiMock.fetchMetaActiveAdConfigsReceipt.mockResolvedValue({
    complete: false,
    termination: "request_failed",
    rows: [],
  });
  readModelMock.buildUnavailableMetaDecisionsWorkspaceReadModel.mockImplementation(
    (input: {
      businessId: string;
      providerAccountId: string | null;
      code: string;
      message: string;
    }) => ({
      contractVersion: "meta-decisions-workspace.read.v1",
      status: "unavailable",
      scope: {
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
      },
      unavailable: { code: input.code, message: input.message },
    }),
  );
  readModelMock.readMetaDecisionsWorkspaceReadModel.mockResolvedValue({
    contractVersion: "meta-decisions-workspace.read.v1",
    status: "available",
    scope: { businessId: "biz_1", providerAccountId: "act_1" },
  });
  readModelMock.readMetaDecisionCampaignContextRows.mockResolvedValue([]);
  readModelMock.applyMetaExecutionGovernanceToReadModel.mockImplementation(
    (input: { model: unknown }) => input.model,
  );
  pipelineHealthMock.readMetaDecisionPipelineOperationalHealth.mockResolvedValue(
    healthyPipelineHealth(),
  );
  pipelineHealthMock.buildMetaDecisionPipelineHealth.mockReturnValue(
    healthyPipelineHealth(),
  );
  governanceMock.readEffectiveMetaWriteGovernance.mockResolvedValue({
    verified: true,
    controlsConfigured: true,
    writeBlocked: false,
    blockReason: null,
    killSwitchEngaged: false,
    killSwitchReason: null,
  });
  commercialTargetsMock.readMetaCommercialTargets.mockResolvedValue({
    source: "configured_targets",
    targetRoas: 2.2,
    breakEvenRoas: 1.8,
    targetCpa: null,
    breakEvenCpa: null,
    riskPosture: "balanced",
    freshness: "fresh",
    updatedAt: "2026-08-07T00:00:00.000Z",
  });
  commercialTargetsMock.hasMetaHardActionAnchor.mockReturnValue(true);
  anchorMock.resolveAccountDecisionProfile.mockResolvedValue({
    hardActionEligibility: null,
  });
  shopifyAovMock.resolveObservedShopifyAov.mockResolvedValue(null);
  targetPackMock.getBusinessTargetPack.mockResolvedValue({
    targetCpa: null,
    targetRoas: 2.2,
    breakEvenCpa: null,
    breakEvenRoas: 1.8,
    operatorAovAssumption: null,
    defaultRiskPosture: "balanced",
    updatedAt: "2026-08-07T00:00:00.000Z",
    freshness: "fresh",
  });
  dbMock.getDb.mockReturnValue({
    query: vi.fn(async () => [{ currency: "USD" }]),
  });
});

function stubUpstreams(lanes: ReturnType<typeof metaLanePayload>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/meta/account-pulse") return jsonResponse(metaPulse());
      if (pathname === "/api/meta/lane-classify") return jsonResponse(lanes);
      return jsonResponse({ error: "unexpected" }, 404);
    }),
  );
}

async function serve() {
  const response = await GET(
    new NextRequest(
      "http://localhost/api/meta/decisions-workspace?businessId=biz_1&providerAccountId=act_9000000000001",
    ),
  );
  return { response, payload: await response.json() };
}

describe("served action census", () => {
  it("counts the typed verb the row actually offers, not the engine's authority stamp", async () => {
    const bid = cappedAdsetBidRow();
    const pause = pauseCandidateRow();
    const lanes = metaLanePayload({
      actionNow: [],
      watching: [bid, pause, stateRow("rec_state_1"), stateRow("rec_state_2")],
      healthy: [],
      nonSales: [],
      archive: [],
      counts: { actionNow: 0, watching: 4, healthy: 0, nonSales: 0, archive: 0 },
    });
    stubUpstreams(lanes);

    const { response, payload } = await serve();

    expect(response.status).toBe(200);
    // The premise: these rows carry NO execute_* stamp, because none exists.
    expect(bid.actionKind).toBe("review_drill");
    expect(pause.actionKind).toBe("review_drill");
    expect(bid.operatorApply).toEqual({
      action: "bid",
      grain: "adset",
      entityId: "9000000000201",
      bidAmountMinor: 1320,
    });
    expect(payload.queue.actionStates).toEqual({
      executablePause: 1,
      executableBid: 1,
      executableResume: 0,
      launchpadRoutes: 0,
      reviewOnly: 2,
      missingActionKind: 0,
    });
  });

  it("still reports review-only when no row offers a verb", async () => {
    const lanes = metaLanePayload({
      actionNow: [],
      watching: [stateRow("rec_state_1"), stateRow("rec_state_2")],
      healthy: [],
      nonSales: [],
      archive: [],
      counts: { actionNow: 0, watching: 2, healthy: 0, nonSales: 0, archive: 0 },
    });
    stubUpstreams(lanes);

    const { payload } = await serve();

    expect(payload.queue.actionStates).toMatchObject({
      executableBid: 0,
      executablePause: 0,
      executableResume: 0,
      reviewOnly: 2,
    });
  });

  it("proves the engine stamp alone can never satisfy an executable counter", () => {
    // Every shape the census could be handed, driven through the real stamp.
    const shapes: Array<Pick<
      MetaRecommendation,
      "type" | "kind" | "level" | "proposedAction" | "decisionState" | "targetValue"
    >> = [];
    for (const kind of [undefined, "anomaly", "state"] as const) {
      for (const level of ["campaign", "adset", "ad"] as const) {
        for (const decisionState of ["act", "test", "watch"] as const) {
          for (const proposedAction of [
            undefined,
            { kind: "pause" as const },
            { kind: "resume" as const },
            { kind: "apply_bid" as const, bidAmountMinor: 1320 },
          ]) {
            for (const type of [
              "scenario_e1_frequency_fatigue",
              "bid_value_guidance",
              "creative_test_structure",
              "winner_promotion_flow",
              "scenario_a5_post_learning_underperformer",
            ]) {
              shapes.push({
                type,
                kind,
                level,
                decisionState,
                proposedAction,
                campaignId: "9000000000101",
                adsetId: "9000000000201",
                targetValue: {
                  contractVersion: "meta.bid-intent.v1",
                  authorityStatus: "authorised",
                  blockerCodes: [],
                  currentMinorUnits: 1200,
                  proposedMinorUnits: 1320,
                  bidAmountMinor: 1320,
                  currency: "USD",
                  sizingPolicyVersion: "meta.bid-sizing.v1",
                },
              } as (typeof shapes)[number]);
            }
          }
        }
      }
    }
    const stamped = new Set(shapes.map((shape) => serverActionKindForRec(shape)));
    expect(stamped.has("execute_bid" as never)).toBe(false);
    expect(stamped.has("execute_pause" as never)).toBe(false);
    expect(stamped.has("execute_resume" as never)).toBe(false);
    // …while the operator capability does answer for the same shapes, which is
    // why the census reads that instead.
    const offered = shapes.filter((shape) =>
      Boolean(
        serverOperatorApplyForRec(
          shape as Parameters<typeof serverOperatorApplyForRec>[0],
        ),
      ),
    );
    expect(offered.length).toBeGreaterThan(0);
  });
});

describe("serve-time commercial anchor inputs", () => {
  it("hands the account decision profile the store's own average order value", async () => {
    const observed = {
      contract: "meta.observed-shopify-aov.v1" as const,
      status: "observed" as const,
      source: "shopify_revenue_ledger" as const,
      providerAccountId: "shop_1",
      revenueBasis: "net_ledger" as const,
      window: { from: "2026-08-08", to: "2026-09-04" },
      zoneName: "UTC",
      orderCount: 60,
      currency: "USD",
      currencyExponent: 2,
      revenueMinor: 348_000,
      aovMinor: 5_800,
      observedAt: "2026-09-04T00:00:00.000Z",
      knowledgeAsOf: "2026-09-04T12:00:00.000Z",
    };
    shopifyAovMock.resolveObservedShopifyAov.mockResolvedValue(observed);
    stubUpstreams(metaLanePayload({ actionNow: [], watching: [], healthy: [], nonSales: [], archive: [], counts: { actionNow: 0, watching: 0, healthy: 0, nonSales: 0, archive: 0 } }));

    await serve();

    expect(shopifyAovMock.resolveObservedShopifyAov).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
        accountCurrency: "USD",
        currencyExponent: 2,
      }),
    );
    expect(anchorMock.resolveAccountDecisionProfile).toHaveBeenCalledWith(
      expect.objectContaining({ observedShopifyAov: observed }),
    );
  });

  it("does not consult the store when a target CPA is already configured", async () => {
    targetPackMock.getBusinessTargetPack.mockResolvedValue({
      targetCpa: 24,
      targetRoas: 2.2,
      breakEvenCpa: null,
      breakEvenRoas: 1.8,
      operatorAovAssumption: null,
      defaultRiskPosture: "balanced",
      updatedAt: "2026-08-07T00:00:00.000Z",
      freshness: "fresh",
    });
    stubUpstreams(metaLanePayload({ actionNow: [], watching: [], healthy: [], nonSales: [], archive: [], counts: { actionNow: 0, watching: 0, healthy: 0, nonSales: 0, archive: 0 } }));

    await serve();

    expect(shopifyAovMock.resolveObservedShopifyAov).not.toHaveBeenCalled();
    expect(anchorMock.resolveAccountDecisionProfile).toHaveBeenCalledWith(
      expect.objectContaining({ observedShopifyAov: null }),
    );
  });
});
