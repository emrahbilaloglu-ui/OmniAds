import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/meta/account-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta/account-context")>();
  return {
    ...actual,
    // Default-authorised. The deselection refusal has its own suite; these
    // cases are about what the action does once the account is selected.
    resolveMetaAccountAuthority: vi.fn(async () => ({
      state: "authorized" as const,
      errorMessage: null,
    })),
  };
});
vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/meta/ads-action-log", () => ({
  resolveExactMetaAdActionTarget: vi.fn(),
  resolveMetaAdActionTarget: vi.fn(),
  hasRecentPendingMetaAdsAction: vi.fn(),
  createMetaAdsActionLog: vi.fn(),
  createDecisionOriginMetaAdsActionLog: vi.fn(),
  completeMetaAdsActionLog: vi.fn(),
  completeDecisionOriginMetaAdsActionLog: vi.fn(),
  findRecentDuplicateActionResult: vi.fn(),
  listRecentMetaAdsActionLogs: vi.fn(),
}));

vi.mock("@/lib/meta/decision-origin-action-preflight", () => ({
  runServerDecisionOriginAdActionPreflight: vi.fn(),
}));

const access = await import("@/lib/access");
const integrations = await import("@/lib/integrations");
const actionLog = await import("@/lib/meta/ads-action-log");
const decisionPreflight = await import(
  "@/lib/meta/decision-origin-action-preflight"
);
const { POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const USER_ID = "272d0ab8-495b-4679-a4c6-ffa404c389d3";

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });

// The write path reads the connection generation and now FAILS CLOSED on a read
// error — it used to `.catch(() => null)`, which made ads-write skip
// assertProviderWriteAuthorityUnchanged entirely. These tests have no database,
// so without this mock they exercised the guard-disabled path and passed.
vi.mock("@/lib/provider-account-snapshots", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readProviderConnectionGenerationToken: vi.fn().mockResolvedValue("1:connected"),
  };
});

// With the generation present, ads-write now actually performs the atomic
// authority re-check. These tests have no database for it to read, so it is
// stubbed to "unchanged" — the guard's own behaviour is covered by
// lib/meta/write-authority-fail-closed.test.ts and provider-write-authority.
vi.mock("@/lib/provider-write-authority", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertProviderWriteAuthorityUnchanged: vi.fn().mockResolvedValue({ ok: true }),
  };
});
}

function request(body: unknown) {
  return new NextRequest("http://localhost/api/meta/ads/ad_1/pause", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function params(adId = "ad_1") {
  return { params: Promise.resolve({ adId }) };
}

function mockAuthError(status: 401 | 403) {
  vi.mocked(access.requireBusinessAccess).mockResolvedValue({
    error: NextResponse.json(
      {
        error: status === 401 ? "auth_error" : "forbidden",
        message:
          status === 401
            ? "Authentication required."
            : "Insufficient role permissions for this action.",
      },
      { status },
    ),
  } as never);
}

describe("POST /api/meta/ads/[adId]/pause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: USER_ID } },
      membership: { businessId: BUSINESS_ID },
    } as never);
    vi.mocked(actionLog.resolveMetaAdActionTarget).mockResolvedValue({
      ok: true,
      target: {
        businessId: BUSINESS_ID,
        adId: "ad_1",
        creativeId: "creative_1",
        providerAccountId: "act_123",
      },
    } as never);
    vi.mocked(actionLog.resolveExactMetaAdActionTarget).mockResolvedValue({
      ok: true,
      target: {
        businessId: BUSINESS_ID,
        adId: "ad_1",
        creativeId: "creative_1",
        providerAccountId: "act_123",
      },
    } as never);
    vi.mocked(actionLog.hasRecentPendingMetaAdsAction).mockResolvedValue(false);
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: true,
      disposition: "proceed",
      shouldMutate: true,
      blockers: [],
      errorCode: null,
      duplicateReceipt: null,
      decisionAgeHours: 1,
      currentAdStateAgeMinutes: 0,
    });
    vi.mocked(actionLog.createMetaAdsActionLog).mockResolvedValue({
      id: "log_1",
    } as never);
    vi.mocked(actionLog.createDecisionOriginMetaAdsActionLog).mockResolvedValue({
      id: "log_decision_1",
    } as never);
    vi.mocked(actionLog.completeMetaAdsActionLog).mockResolvedValue({
      id: "log_1",
    } as never);
    vi.mocked(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).mockResolvedValue({ id: "log_decision_1" } as never);
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      provider_account_id: "act_123",
      access_token: "secret-token",
    } as never);
  });

  it("returns 401 when no auth session exists", async () => {
    mockAuthError(401);

    const response = await POST(request({ businessId: BUSINESS_ID }), params());

    expect(response.status).toBe(401);
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 403 when role is insufficient", async () => {
    mockAuthError(403);

    const response = await POST(request({ businessId: BUSINESS_ID }), params());

    expect(response.status).toBe(403);
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 400 when businessId is missing", async () => {
    const response = await POST(request({}), params());
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("missing_business_id");
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
  });

  it("returns 404 when the ad is not found locally", async () => {
    vi.mocked(actionLog.resolveMetaAdActionTarget).mockResolvedValue({
      ok: false,
      reason: "ad_not_found",
    } as never);

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error.code).toBe("ad_not_found");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("writes audit success when Meta pause and verification succeed", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "ad_1", status: "PAUSED", effective_status: "PAUSED" }),
      );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, action: "pause", status: "PAUSED" });
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        adId: "ad_1",
        creativeId: "creative_1",
        action: "pause",
        payloadRequest: expect.objectContaining({
          endpoint: "/ad_1",
          body: { status: "PAUSED" },
        }),
      }),
    );
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ id: "log_1", status: "success" }),
    );
  });

  it("uses the exact typed and atomic path for a decision-origin pause", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "ad_1", status: "PAUSED", effective_status: "PAUSED" }),
      );

    const response = await POST(
      request({
        contractVersion: "meta-decision-origin-ad-execution.v1",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "ad_1",
        snapshotId: "00000000-0000-4000-8000-000000000011",
        evaluationId: "00000000-0000-4000-8000-000000000012",
        engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
        decisionHash: "d".repeat(64),
        action: "pause",
        idempotencyKey: "decision-pause-1",
        creativeId: "creative_1",
      }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(actionLog.resolveExactMetaAdActionTarget).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      adId: "ad_1",
    });
    expect(actionLog.resolveMetaAdActionTarget).not.toHaveBeenCalled();
    expect(actionLog.createDecisionOriginMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          businessId: BUSINESS_ID,
          providerAccountId: "act_123",
          adId: "ad_1",
          action: "pause",
        }),
      }),
    );
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: "log_decision_1", status: "success" }),
    );
    expect(actionLog.completeMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("blocks a stale exact decision before creating a log or writing to Meta", async () => {
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: false,
      disposition: "reject",
      shouldMutate: false,
      blockers: ["decision_stale"],
      errorCode: "decision_stale",
      duplicateReceipt: null,
      decisionAgeHours: 13,
      currentAdStateAgeMinutes: 0,
    });

    const response = await POST(
      request({
        contractVersion: "meta-decision-origin-ad-execution.v1",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "ad_1",
        snapshotId: "00000000-0000-4000-8000-000000000011",
        evaluationId: "00000000-0000-4000-8000-000000000012",
        engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
        decisionHash: "d".repeat(64),
        action: "pause",
        idempotencyKey: "decision-pause-stale",
      }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("decision_stale");
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns an existing exact receipt without another Meta write", async () => {
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: true,
      disposition: "duplicate",
      shouldMutate: false,
      blockers: [],
      errorCode: null,
      duplicateReceipt: {
        actionLogId: "log_decision_1",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "ad_1",
        snapshotId: "00000000-0000-4000-8000-000000000011",
        evaluationId: "00000000-0000-4000-8000-000000000012",
        engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
        decisionHash: "d".repeat(64),
        action: "pause",
        idempotencyKey: "decision-pause-1",
        status: "success",
        dryRun: false,
        providerVerified: true,
        treatmentEligible: true,
      },
      decisionAgeHours: null,
      currentAdStateAgeMinutes: null,
    });

    const response = await POST(
      request({
        contractVersion: "meta-decision-origin-ad-execution.v1",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "ad_1",
        snapshotId: "00000000-0000-4000-8000-000000000011",
        evaluationId: "00000000-0000-4000-8000-000000000012",
        engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
        decisionHash: "d".repeat(64),
        action: "pause",
        idempotencyKey: "decision-pause-1",
      }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, duplicate: true, status: "PAUSED" });
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a retryable error when current Meta state is unavailable", async () => {
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: false,
      disposition: "reject",
      shouldMutate: false,
      blockers: ["current_ad_state_unverified"],
      errorCode: "current_ad_state_unverified",
      duplicateReceipt: null,
      decisionAgeHours: 1,
      currentAdStateAgeMinutes: null,
    });

    const response = await POST(
      request({
        contractVersion: "meta-decision-origin-ad-execution.v1",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: "ad_1",
        snapshotId: "00000000-0000-4000-8000-000000000011",
        evaluationId: "00000000-0000-4000-8000-000000000012",
        engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
        decisionHash: "d".repeat(64),
        action: "pause",
        idempotencyKey: "decision-pause-state-unavailable",
      }),
      params(),
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe("current_ad_state_unverified");
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("logs silent_failure when Meta success verifies unchanged", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "ad_1", status: "ACTIVE", effective_status: "ACTIVE" }),
      );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe("silent_failure");
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: "silent_failure" }),
    );
  });

  it("logs failure when Meta returns an HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 190, message: "Invalid OAuth access token." } },
        { status: 400 },
      ),
    );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe("190");
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failure", errorCode: "190" }),
    );
  });

  it("retries once after Meta rate limiting and succeeds on the second write", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 17, message: "(#17) User request limit reached" } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "ad_1", status: "PAUSED", effective_status: "PAUSED" }),
      );

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" }),
    );
  });

  it("returns 409 when a pending row exists for the same ad", async () => {
    vi.mocked(actionLog.hasRecentPendingMetaAdsAction).mockResolvedValue(true);

    const response = await POST(request({ businessId: BUSINESS_ID }), params());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("action_in_flight");
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
