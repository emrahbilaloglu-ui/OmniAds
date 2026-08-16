import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  metaLanePayload,
  metaPulse,
  metaRec,
} from "@/components/meta/redesign/test-fixtures";
import { GET } from "@/app/api/meta/decisions-workspace/route";

const accessMock = vi.hoisted(() => ({
  requireBusinessAccess: vi.fn(),
}));
const reviewerMock = vi.hoisted(() => ({
  isReviewerEmail: vi.fn(),
}));
const dbMock = vi.hoisted(() => ({
  getDb: vi.fn(),
}));
const assignmentsMock = vi.hoisted(() => ({
  getProviderAccountAssignments: vi.fn(),
}));
const readModelMock = vi.hoisted(() => ({
  buildUnavailableMetaDecisionsWorkspaceReadModel: vi.fn(),
  readMetaDecisionCampaignContextRows: vi.fn(),
  readMetaDecisionsWorkspaceReadModel: vi.fn(),
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

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: accessMock.requireBusinessAccess,
}));

vi.mock("@/lib/reviewer-access", () => ({
  isReviewerEmail: reviewerMock.isReviewerEmail,
}));

vi.mock("@/lib/db", () => ({
  getDb: dbMock.getDb,
}));

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: assignmentsMock.getProviderAccountAssignments,
}));

vi.mock("@/lib/meta/decisions-workspace-read-model", () => ({
  resolveProvisionalCampaignKind: vi.fn(() => "main"),
  buildUnavailableMetaDecisionsWorkspaceReadModel:
    readModelMock.buildUnavailableMetaDecisionsWorkspaceReadModel,
  readMetaDecisionCampaignContextRows:
    readModelMock.readMetaDecisionCampaignContextRows,
  readMetaDecisionsWorkspaceReadModel:
    readModelMock.readMetaDecisionsWorkspaceReadModel,
}));

vi.mock("@/lib/meta/commercial-targets", () => ({
  hasMetaHardActionAnchor: commercialTargetsMock.hasMetaHardActionAnchor,
  readMetaCommercialTargets: commercialTargetsMock.readMetaCommercialTargets,
}));

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubWorkspaceHttpUpstreams() {
  const pulse = metaPulse();
  const lanes = metaLanePayload();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/meta/account-pulse") return jsonResponse(pulse);
      if (pathname === "/api/meta/lane-classify") return jsonResponse(lanes);
      return jsonResponse({ error: "unexpected" }, 404);
    }),
  );
}

function mockDigestSql(input?: {
  labelRows?: Array<Record<string, unknown>>;
  actionRows?: Array<Record<string, unknown>>;
  anomalyRows?: Array<Record<string, unknown>>;
  deferralRows?: Array<Record<string, unknown>>;
}) {
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const query = Array.from(strings).join("?");
    if (query.includes("FROM meta_ads_action_log log"))
      return input?.actionRows ?? [];
    if (query.includes("COALESCE(snapshot.kind, 'recommendation') = 'anomaly'"))
      return input?.anomalyRows ?? [];
    if (query.includes("FROM meta_decision_responses response"))
      return input?.deferralRows ?? [];
    if (query.includes("FROM meta_decision_snapshots_daily snapshot"))
      return input?.labelRows ?? [];
    return [];
  });
  dbMock.getDb.mockReturnValue(sql);
  return sql;
}

describe("GET /api/meta/decisions-workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    accessMock.requireBusinessAccess.mockResolvedValue({
      session: {
        sessionId: "sess_1",
        activeBusinessId: "biz_1",
        expiresAt: "2026-07-08T00:00:00.000Z",
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
        joinedAt: "2026-07-08T00:00:00.000Z",
      },
    });
    reviewerMock.isReviewerEmail.mockReturnValue(false);
    assignmentsMock.getProviderAccountAssignments.mockResolvedValue(null);
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
    commercialTargetsMock.readMetaCommercialTargets.mockResolvedValue({
      source: "none",
      targetRoas: null,
      breakEvenRoas: null,
      targetCpa: null,
      breakEvenCpa: null,
      riskPosture: "balanced",
      freshness: "unknown",
      updatedAt: null,
    });
    commercialTargetsMock.hasMetaHardActionAnchor.mockImplementation(
      (
        targets: {
          source?: string;
          freshness?: string;
          updatedAt?: string | null;
        } | null,
      ) =>
        targets?.source === "configured_targets" &&
        targets.freshness !== "unknown" &&
        Boolean(targets.updatedAt),
    );
    dbMock.getDb.mockImplementation(() => {
      throw new Error("db unavailable in this unit test");
    });
  });

  it("requires a business id before calling upstream read models", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new NextRequest("http://localhost/api/meta/decisions-workspace"),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("businessId is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("authorizes the business before using shared workspace caches", async () => {
    accessMock.requireBusinessAccess.mockResolvedValue({
      error: NextResponse.json(
        { error: "auth_error", message: "You do not have access." },
        { status: 403 },
      ),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1",
      ),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("composes production upstreams in-process without an HTTP self-fetch", async () => {
    vi.stubEnv("META_DECISIONS_UPSTREAM_TRANSPORT", "in_process");
    const pulse = metaPulse();
    const lanes = metaLanePayload();
    upstreamRouteMock.accountPulseGet.mockResolvedValue(jsonResponse(pulse));
    upstreamRouteMock.laneClassificationGet.mockResolvedValue(
      jsonResponse(lanes),
    );
    const fetchMock = vi.fn(() => {
      throw new Error("HTTP self-fetch must not run");
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1&surface=os",
        { headers: { cookie: "session=test-session" } },
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.businessId).toBe("biz_1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upstreamRouteMock.accountPulseGet).toHaveBeenCalledTimes(1);
    expect(upstreamRouteMock.laneClassificationGet).toHaveBeenCalledTimes(1);
    const accountPulseRequest = upstreamRouteMock.accountPulseGet.mock
      .calls[0]?.[0] as NextRequest;
    expect(accountPulseRequest.nextUrl.pathname).toBe(
      "/api/meta/account-pulse",
    );
    expect(accountPulseRequest.headers.get("cookie")).toBe(
      "session=test-session",
    );
  });

  it("keeps the canonical read model unavailable until providerAccountId is explicit", async () => {
    const pulse = metaPulse();
    const lanes = metaLanePayload();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/meta/account-pulse") return jsonResponse(pulse);
        if (pathname === "/api/meta/lane-classify") return jsonResponse(lanes);
        return jsonResponse({ error: "unexpected" }, 404);
      }),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.decisionReadModel).toMatchObject({
      contractVersion: "meta-decisions-workspace.read.v1",
      status: "unavailable",
      scope: { providerAccountId: null },
      unavailable: { code: "provider_account_required" },
    });
    expect(
      assignmentsMock.getProviderAccountAssignments,
    ).not.toHaveBeenCalled();
    expect(
      readModelMock.readMetaDecisionsWorkspaceReadModel,
    ).not.toHaveBeenCalled();
  });

  it("validates and forwards providerAccountId before reading the account-scoped model", async () => {
    assignmentsMock.getProviderAccountAssignments.mockResolvedValue({
      id: "assignment_1",
      business_id: "biz_1",
      provider: "meta",
      account_ids: ["act_1"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    const pulse = metaPulse();
    const lanes = metaLanePayload();
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      expect(requestUrl.searchParams.get("providerAccountId")).toBe("act_1");
      if (requestUrl.pathname === "/api/meta/account-pulse")
        return jsonResponse(pulse);
      if (requestUrl.pathname === "/api/meta/lane-classify")
        return jsonResponse(lanes);
      return jsonResponse({ error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1&providerAccountId=act_1&adLimit=120",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(assignmentsMock.getProviderAccountAssignments).toHaveBeenCalledWith(
      "biz_1",
      "meta",
    );
    expect(
      readModelMock.readMetaDecisionsWorkspaceReadModel,
    ).toHaveBeenCalledWith({
      businessId: "biz_1",
      providerAccountId: "act_1",
      adCandidateLimit: 120,
      asOfDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      currentAds: [],
      currentAdSourceComplete: false,
    });
    expect(payload.decisionReadModel).toMatchObject({
      status: "available",
      scope: { businessId: "biz_1", providerAccountId: "act_1" },
    });
    expect(
      readModelMock.readMetaDecisionCampaignContextRows,
    ).toHaveBeenCalledWith({
      businessId: "biz_1",
      providerAccountId: "act_1",
      campaignIds: ["cmp_1"],
      snapshotAsOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it("keeps every current ACTIVE Ad visible when an exact decision snapshot is pending", async () => {
    assignmentsMock.getProviderAccountAssignments.mockResolvedValue({
      id: "assignment_1",
      business_id: "biz_1",
      provider: "meta",
      account_ids: ["act_1"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    metaApiMock.resolveMetaCredentials.mockResolvedValue({
      businessId: "biz_1",
      accessToken: "test-token",
      accountIds: ["act_1"],
      currency: "USD",
      accountProfiles: {},
    });
    metaApiMock.fetchMetaActiveAdConfigsReceipt.mockResolvedValue({
      complete: true,
      termination: "natural_end",
      rows: [
        {
          id: "120000000000000001",
          name: "Current active Ad",
          campaign_id: "cmp_1",
          campaign: { id: "cmp_1", name: "Main Winners" },
          adset_id: "adset_1",
          creative: { id: "creative_1" },
          status: "ACTIVE",
          effective_status: "ACTIVE",
          updated_time: "2026-07-13T08:00:00.000Z",
        },
        {
          id: "120000000000000002",
          name: "Paused Ad",
          campaign_id: "cmp_1",
          adset_id: "adset_1",
          creative: { id: "creative_2" },
          status: "PAUSED",
          effective_status: "PAUSED",
          updated_time: "2026-07-13T08:00:00.000Z",
        },
      ],
    });
    readModelMock.readMetaDecisionCampaignContextRows.mockResolvedValue([
      {
        campaignId: "cmp_1",
        kind: null,
        suggestedKind: "main",
        source: "system_inferred",
        confidenceClass: "unknown",
        sourceUpdatedAt: "2026-07-13T04:00:00.000Z",
        resolverVersion: "campaign-context-resolver.v1",
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/meta/account-pulse")
          return jsonResponse(metaPulse());
        if (pathname === "/api/meta/lane-classify")
          return jsonResponse(metaLanePayload());
        return jsonResponse({ error: "unexpected" }, 404);
      }),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1&providerAccountId=act_1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(
      readModelMock.readMetaDecisionsWorkspaceReadModel,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        currentAdSourceComplete: true,
        currentAds: expect.arrayContaining([
          expect.objectContaining({
            adId: "120000000000000001",
            effectiveStatus: "ACTIVE",
          }),
        ]),
      }),
    );
    expect(payload.os.ads.items).toHaveLength(1);
    expect(payload.os.ads.items[0]).toMatchObject({
      adId: "120000000000000001",
      adName: "Current active Ad",
      campaignName: "Main Winners",
      lifecycleRole: "main",
      campaignRoleSource: "automatic",
      lane: "blocked",
      decisionAvailability: "pending_native_evidence",
      action: { code: "await_ad_grain_evidence", providerMutation: null },
    });
    expect(
      readModelMock.readMetaDecisionCampaignContextRows,
    ).toHaveBeenCalledWith({
      businessId: "biz_1",
      providerAccountId: "act_1",
      campaignIds: ["cmp_1"],
      snapshotAsOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it("aligns downstream evidence reads to the latest account snapshot or native job attempt", async () => {
    assignmentsMock.getProviderAccountAssignments.mockResolvedValue({
      id: "assignment_1",
      business_id: "biz_1",
      provider: "meta",
      account_ids: ["act_1"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    const sql = mockDigestSql();
    Object.assign(sql, {
      query: vi.fn().mockResolvedValue([{ latest_as_of: "2026-07-10" }]),
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      expect(requestUrl.searchParams.get("endDate")).toBe("2026-07-10");
      if (requestUrl.pathname === "/api/meta/account-pulse")
        return jsonResponse(metaPulse());
      if (requestUrl.pathname === "/api/meta/lane-classify")
        return jsonResponse(metaLanePayload());
      return jsonResponse({ error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1&providerAccountId=act_1",
      ),
    );

    expect(response.status).toBe(200);
    expect(
      (sql as typeof sql & { query: ReturnType<typeof vi.fn> }).query,
    ).toHaveBeenCalledWith(
      expect.stringMatching(
        /engine_v3_ad_decision_snapshots_daily[\s\S]*engine_v3_job_runs/,
      ),
      ["biz_1", "act_1"],
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects provider accounts that are not assigned to the business", async () => {
    assignmentsMock.getProviderAccountAssignments.mockResolvedValue({
      id: "assignment_1",
      business_id: "biz_1",
      provider: "meta",
      account_ids: ["act_other"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    const pulse = metaPulse();
    const lanes = metaLanePayload();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/meta/account-pulse") return jsonResponse(pulse);
        if (pathname === "/api/meta/lane-classify") return jsonResponse(lanes);
        return jsonResponse({ error: "unexpected" }, 404);
      }),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1&providerAccountId=act_1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe("provider_account_not_assigned");
    expect(
      readModelMock.readMetaDecisionsWorkspaceReadModel,
    ).not.toHaveBeenCalled();
  });

  it("forwards query and auth context, rechecks current commercial authority, then composes the workspace", async () => {
    commercialTargetsMock.readMetaCommercialTargets.mockResolvedValue({
      source: "configured_targets",
      targetRoas: 2.5,
      breakEvenRoas: 1.8,
      targetCpa: null,
      breakEvenCpa: null,
      riskPosture: "balanced",
      freshness: "fresh",
      updatedAt: "2026-07-13T00:00:00.000Z",
    });
    const pulse = metaPulse({ currency: "EUR" });
    const missingActionKind = metaRec({ id: "missing" });
    delete missingActionKind.actionKind;
    const lanes = metaLanePayload({
      actionNow: [
        metaRec({ id: "pause", actionKind: "execute_pause" }),
        metaRec({ id: "bid", actionKind: "execute_bid" }),
        metaRec({ id: "route", actionKind: "route_launchpad_duplicate" }),
      ],
      watching: [metaRec({ id: "review", actionKind: "review_drill" })],
      nonSales: [missingActionKind],
      healthy: [],
      archive: [],
      counts: {
        actionNow: 3,
        watching: 1,
        healthy: 0,
        nonSales: 1,
        archive: 0,
      },
    });
    const sql = mockDigestSql({
      labelRows: [
        {
          rec_id: "rec_flip",
          scope_id: "cmp_1",
          title: "Retargeting 30d",
          snapshot_date: "2026-05-07",
          previous_label: "watch",
          current_label: "act",
        },
      ],
      actionRows: [
        {
          id: "action_1",
          action: "pause",
          status: "success",
          target: "Broad LAL 2",
          actor: "Autopilot",
          occurred_at: "2026-05-07T06:41:00.000Z",
          error_code: null,
          error_message: null,
        },
        {
          id: "action_2",
          action: "pause",
          status: "silent_failure",
          target: "Broad Test 01",
          actor: "Deniz",
          occurred_at: "2026-05-07T06:52:00.000Z",
          error_code: "silent_failure",
          error_message: "Meta verification disagreed.",
        },
      ],
      anomalyRows: [
        {
          id: "anom_1",
          title: "Purchase-event drop",
          status: "open",
          occurred_at: "2026-05-07T05:12:00.000Z",
        },
      ],
      deferralRows: [
        {
          rec_id: "rec_deferred",
          title: "Creator Test 03",
          due_at: "2026-05-07T06:00:00.000Z",
          detail: "let_cook_24h",
        },
      ],
    });
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = new URL(String(url));
        expect(requestUrl.searchParams.get("businessId")).toBe("biz_1");
        expect(requestUrl.searchParams.get("window")).toBe("custom");
        expect(requestUrl.searchParams.get("status_filter")).toBe("all");
        expect(requestUrl.searchParams.get("startDate")).toBe("2026-05-01");
        expect(requestUrl.searchParams.get("endDate")).toBe("2026-05-07");
        expect(new Headers(init?.headers).get("cookie")).toBe("session=abc");
        if (requestUrl.pathname === "/api/meta/account-pulse")
          return jsonResponse(pulse);
        if (requestUrl.pathname === "/api/meta/lane-classify")
          return jsonResponse(lanes);
        return jsonResponse({ error: "unexpected" }, 404);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1&window=custom&status_filter=all&startDate=2026-05-01&endDate=2026-05-07",
        { headers: { cookie: "session=abc" } },
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      commercialTargetsMock.readMetaCommercialTargets,
    ).toHaveBeenCalledWith("biz_1");
    expect(payload.system.currency).toBe("EUR");
    expect(payload.queue.groups).toEqual([
      { key: "action", label: "Action Now", count: 3 },
      { key: "watching", label: "Watching", count: 1 },
      { key: "healthy", label: "Healthy", count: 0 },
      { key: "nonSales", label: "Non-sales", count: 1 },
      { key: "archive", label: "Inactive assets", count: 0 },
    ]);
    expect(payload.queue.actionStates).toEqual({
      executablePause: 1,
      executableBid: 1,
      executableResume: 0,
      launchpadRoutes: 1,
      reviewOnly: 1,
      missingActionKind: 1,
    });
    expect(sql).toHaveBeenCalledTimes(4);
    expect(payload.digest).toMatchObject({
      snapshotDate: "2026-05-07",
      labelFlips: {
        count: 1,
        publishedCount: 1,
        items: [
          {
            title: "Retargeting 30d",
            previousLabel: "watch",
            currentLabel: "act",
          },
        ],
      },
      actions: {
        verifiedCount: 1,
        silentFailureCount: 1,
        items: [
          { target: "Broad LAL 2", status: "verified" },
          {
            target: "Broad Test 01",
            status: "silent_failure",
            detail: "Meta verification disagreed.",
          },
        ],
      },
      anomalies: { openedCount: 1 },
      deferrals: { dueCount: 1 },
    });
  });

  it("serves a compact OS payload without duplicate lane, digest, or canonical queues", async () => {
    assignmentsMock.getProviderAccountAssignments.mockResolvedValue({
      id: "assignment_1",
      business_id: "biz_1",
      provider: "meta",
      account_ids: ["act_1"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    metaApiMock.resolveMetaCredentials.mockResolvedValue({
      accessToken: "token",
      accountIds: ["act_1"],
    });
    metaApiMock.fetchMetaActiveAdConfigsReceipt.mockResolvedValue({
      complete: true,
      termination: "complete",
      rows: [
        {
          id: "ad_1",
          name: "Active Ad",
          campaign_id: "campaign_1",
          adset_id: "adset_1",
          status: "ACTIVE",
          effective_status: "ACTIVE",
          creative: { id: "creative_1" },
        },
      ],
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      expect(requestUrl.searchParams.get("status_filter")).toBe("active");
      expect(requestUrl.searchParams.get("workspace_surface")).toBe("os");
      if (requestUrl.pathname === "/api/meta/account-pulse") {
        return jsonResponse(
          metaPulse({
            lastSyncAt: "2026-07-13T03:05:00.000Z",
            roasHistory: [3.9, 4.05, 4.26],
          }),
        );
      }
      if (requestUrl.pathname === "/api/meta/lane-classify") {
        return jsonResponse(metaLanePayload());
      }
      return jsonResponse({ error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1&providerAccountId=act_1&surface=os",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.os).toBeDefined();
    // The compact surface carries the account facts the Decision Center header
    // states -- a projection of the pulse already loaded, not a second read.
    expect(payload.pulse.lastSyncAt).toBe("2026-07-13T03:05:00.000Z");
    expect(payload.pulse.roasHistory).toEqual([3.9, 4.05, 4.26]);
    expect(Object.keys(payload.pulse).sort()).toEqual([
      "labelCoverage",
      "lastSyncAt",
      "operatingMode",
      "pacing",
      "roas",
      "roasHistory",
      "seasonalRegime",
      "trackingHealth",
    ].sort());
    // Still compact: the heavy lane/queue/digest sections stay stripped.
    expect(payload.decisionReadModel).toEqual({
      status: "available",
      unavailable: null,
    });
    expect(payload).not.toHaveProperty("lanes");
    expect(payload).not.toHaveProperty("queue");
    expect(payload).not.toHaveProperty("digest");
  });

  it("does not substitute stale snapshots when compact active inventory is unavailable", async () => {
    assignmentsMock.getProviderAccountAssignments.mockResolvedValue({
      id: "assignment_1",
      business_id: "biz_1",
      provider: "meta",
      account_ids: ["act_1"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    stubWorkspaceHttpUpstreams();

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1&providerAccountId=act_1&surface=os",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.decisionReadModel.status).toBe("unavailable");
    expect(payload.decisionReadModel.unavailable).toMatchObject({
      code: "source_read_failed",
    });
    expect(readModelMock.readMetaDecisionsWorkspaceReadModel).not.toHaveBeenCalled();
  });

  it("surfaces missing-data, tracking, snapshot, and kill-switch banners without fabricating zeros", async () => {
    vi.stubEnv("META_ADS_WRITE_KILL_SWITCH", "1");
    const pulse = metaPulse({
      currency: null,
      trackingAnomalyActive: true,
      trackingHealth: {
        status: "degraded",
        detail: "Purchase signal is incomplete.",
      },
      dataReadiness: {
        status: "not_connected",
        isPartial: true,
        notReadyReason: "Meta account is not connected.",
        evidenceSource: "meta_status",
      },
      snapshotHealth: {
        latestSnapshotDate: null,
        lastRunAt: null,
        engineVersion: null,
        currentEngineVersion: "v-current",
        isCurrentEngineVersion: false,
        ageHours: null,
        status: "missing",
        staleReason:
          "No persisted recommendation snapshot exists for this business.",
      },
    });
    const lanes = metaLanePayload({
      actionNow: [],
      watching: [],
      healthy: [],
      nonSales: [],
      archive: [],
      counts: {
        actionNow: 0,
        watching: 0,
        healthy: 0,
        nonSales: 0,
        archive: 0,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/meta/account-pulse") return jsonResponse(pulse);
        if (pathname === "/api/meta/lane-classify") return jsonResponse(lanes);
        return jsonResponse({ error: "unexpected" }, 404);
      }),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.system.currency).toBeNull();
    expect(payload.system.trackingBlocked).toBe(true);
    expect(payload.system.killSwitchEngaged).toBe(true);
    expect(payload.banners.map((banner: { id: string }) => banner.id)).toEqual([
      "data_readiness",
      "commercial_target_authority_missing",
      "tracking_write_gate",
      "snapshot_health",
      "meta_write_kill_switch",
    ]);
    expect(
      payload.queue.groups.find(
        (group: { key: string }) => group.key === "action",
      ).count,
    ).toBe(0);
  });

  it("serves old-target review as advisory without suppressing engine authority", async () => {
    commercialTargetsMock.readMetaCommercialTargets.mockResolvedValue({
      source: "configured_targets",
      targetRoas: 2.5,
      breakEvenRoas: 1.8,
      targetCpa: null,
      breakEvenCpa: null,
      riskPosture: "balanced",
      freshness: "stale",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    const pulse = metaPulse();
    const lanes = metaLanePayload();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/meta/account-pulse") return jsonResponse(pulse);
        if (pathname === "/api/meta/lane-classify") return jsonResponse(lanes);
        return jsonResponse({ error: "unexpected" }, 404);
      }),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1&surface=os",
      ),
    );
    const payload = await response.json();
    const banner = payload.banners.find(
      (item: { id: string }) => item.id === "stale_commercial_target_authority",
    );

    expect(response.status).toBe(200);
    expect(
      commercialTargetsMock.readMetaCommercialTargets,
    ).toHaveBeenCalledWith("biz_1");
    expect(banner).toMatchObject({
      scope: "target_hard_actions",
      blocking: false,
      action: {
        label: "Review commercial truth",
        href: "/commercial-truth",
      },
    });
    expect(banner.detail).toContain("age does not suppress");
    expect(banner.detail).not.toContain("authority is suppressed");
  });

  it("does not show a target-authority warning for fresh configured targets", async () => {
    commercialTargetsMock.readMetaCommercialTargets.mockResolvedValue({
      source: "configured_targets",
      targetRoas: 2.5,
      breakEvenRoas: 1.8,
      targetCpa: null,
      breakEvenCpa: null,
      riskPosture: "balanced",
      freshness: "fresh",
      updatedAt: "2026-07-13T00:00:00.000Z",
    });
    const pulse = metaPulse();
    const lanes = metaLanePayload();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/meta/account-pulse") return jsonResponse(pulse);
        if (pathname === "/api/meta/lane-classify") return jsonResponse(lanes);
        return jsonResponse({ error: "unexpected" }, 404);
      }),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(
      payload.banners.some(
        (item: { scope?: string }) => item.scope === "target_hard_actions",
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "missing",
      targets: {
        source: "none",
        targetRoas: null,
        breakEvenRoas: null,
        targetCpa: null,
        breakEvenCpa: null,
        riskPosture: "balanced",
        freshness: "unknown",
        updatedAt: null,
      },
      expectedId: "commercial_target_authority_missing",
      expectedTitle: "Commercial targets are not configured.",
    },
    {
      name: "configured with unknown freshness",
      targets: {
        source: "configured_targets",
        targetRoas: 2.5,
        breakEvenRoas: 1.8,
        targetCpa: null,
        breakEvenCpa: null,
        riskPosture: "balanced",
        freshness: "unknown",
        updatedAt: null,
      },
      expectedId: "stale_commercial_target_authority",
      expectedTitle: "Commercial target freshness is unknown.",
    },
  ])(
    "surfaces $name target authority as a scoped warning",
    async ({ targets, expectedId, expectedTitle }) => {
      commercialTargetsMock.readMetaCommercialTargets.mockResolvedValue(
        targets,
      );
      stubWorkspaceHttpUpstreams();
      const response = await GET(
        new NextRequest(
          "http://localhost/api/meta/decisions-workspace?businessId=biz_1&surface=os",
        ),
      );
      const payload = await response.json();
      const banner = payload.banners.find(
        (item: { id: string }) => item.id === expectedId,
      );

      expect(response.status).toBe(200);
      expect(banner).toMatchObject({
        title: expectedTitle,
        scope: "target_hard_actions",
        blocking: false,
      });
    },
  );

  it("surfaces a target read failure without globally blocking review flows", async () => {
    commercialTargetsMock.readMetaCommercialTargets.mockRejectedValue(
      new Error("target history unavailable"),
    );
    stubWorkspaceHttpUpstreams();
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1&surface=os",
      ),
    );
    const payload = await response.json();
    const banner = payload.banners.find(
      (item: { id: string }) =>
        item.id === "commercial_target_authority_unavailable",
    );

    expect(response.status).toBe(200);
    expect(banner).toMatchObject({
      scope: "target_hard_actions",
      blocking: false,
    });
  });

  it("adds reviewer read-only posture from server session state without changing queue action authority", async () => {
    commercialTargetsMock.readMetaCommercialTargets.mockResolvedValue({
      source: "configured_targets",
      targetRoas: 2.5,
      breakEvenRoas: 1.8,
      targetCpa: null,
      breakEvenCpa: null,
      riskPosture: "balanced",
      freshness: "fresh",
      updatedAt: "2026-07-13T00:00:00.000Z",
    });
    accessMock.requireBusinessAccess.mockResolvedValue({
      session: {
        sessionId: "sess_1",
        activeBusinessId: "biz_1",
        expiresAt: "2026-07-08T00:00:00.000Z",
        user: {
          id: "user_1",
          name: "Reviewer",
          email: "shopify-review@adsecute.com",
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
        joinedAt: "2026-07-08T00:00:00.000Z",
      },
    });
    reviewerMock.isReviewerEmail.mockReturnValue(true);
    const pulse = metaPulse();
    const lanes = metaLanePayload({
      actionNow: [metaRec({ id: "pause-rec", actionKind: "execute_pause" })],
      watching: [],
      nonSales: [],
      healthy: [],
      archive: [],
      counts: {
        actionNow: 1,
        watching: 0,
        healthy: 0,
        nonSales: 0,
        archive: 0,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/meta/account-pulse") return jsonResponse(pulse);
        if (pathname === "/api/meta/lane-classify") return jsonResponse(lanes);
        return jsonResponse({ error: "unexpected" }, 404);
      }),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(accessMock.requireBusinessAccess).toHaveBeenCalledWith({
      request: expect.any(NextRequest),
      businessId: "biz_1",
      minRole: "guest",
    });
    expect(payload.viewer).toMatchObject({
      role: "collaborator",
      isReviewer: true,
      readOnly: true,
    });
    expect(
      payload.banners.map((banner: { id: string }) => banner.id),
    ).toContain("reviewer_read_only");
    expect(payload.queue.actionStates.executablePause).toBe(1);
  });

  it("does not downgrade Structure hard actions because a valid target is old", async () => {
    commercialTargetsMock.readMetaCommercialTargets.mockResolvedValue({
      source: "configured_targets",
      targetRoas: 2.5,
      breakEvenRoas: 1.8,
      targetCpa: null,
      breakEvenCpa: null,
      riskPosture: "balanced",
      freshness: "stale",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    const cut = metaRec({
      id: "stale-structure-cut",
      level: "adset",
      campaignId: "cmp_1",
      campaignName: "Main campaign",
      adsetId: "set_1",
      adsetName: "Broad",
      decisionLabel: "cut",
      actionKind: "execute_pause",
      primaryActionLabel: "Pause Ad Set",
      proposedAction: { kind: "pause" },
    });
    const lanes = metaLanePayload({
      actionNow: [cut],
      watching: [],
      nonSales: [],
      healthy: [],
      archive: [],
      counts: {
        actionNow: 1,
        watching: 0,
        healthy: 0,
        nonSales: 0,
        archive: 0,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/meta/account-pulse") {
          return jsonResponse(metaPulse());
        }
        if (pathname === "/api/meta/lane-classify") return jsonResponse(lanes);
        return jsonResponse({ error: "unexpected" }, 404);
      }),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1",
      ),
    );
    const payload = await response.json();
    const structureNode = payload.os.structure.groups[0].adsets[0];

    expect(response.status).toBe(200);
    expect(payload.lanes.actionNow[0]).toMatchObject({
      id: "stale-structure-cut",
      decisionLabel: "cut",
      actionKind: "execute_pause",
      primaryActionLabel: "Pause Ad Set",
    });
    expect(payload.lanes.watching).toHaveLength(0);
    expect(payload.lanes.watchingSegments).toEqual([]);
    expect(payload.queue.groups[0]).toMatchObject({
      key: "action",
      count: 1,
    });
    expect(payload.queue.groups[1]).toMatchObject({
      key: "watching",
      count: 0,
    });
    expect(payload.queue.actionStates).toMatchObject({
      executablePause: 1,
      reviewOnly: 0,
    });
    expect(structureNode).toMatchObject({
      lane: "act",
      assessment: "Underperformer",
      action: {
        code: "execute_pause",
        intent: "review",
        providerMutation: "pause",
      },
    });
  });

  it("propagates upstream failures with source metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/meta/account-pulse")
          return jsonResponse({ message: "not allowed" }, 403);
        if (pathname === "/api/meta/lane-classify")
          return jsonResponse(metaLanePayload());
        return jsonResponse({ error: "unexpected" }, 404);
      }),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decisions-workspace?businessId=biz_1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe("upstream_failed");
    expect(payload.source).toBe("account-pulse");
    expect(payload.detail).toEqual({ message: "not allowed" });
  });
});
