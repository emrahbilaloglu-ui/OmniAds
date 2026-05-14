import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/demo-business", () => ({
  getDemoProviderDiscoveryPayload: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/meta-ad-accounts", () => ({
  fetchMetaAdAccounts: vi.fn(),
  getMetaApiErrorMessage: vi.fn(() => "Meta API error"),
}));

vi.mock("@/lib/provider-account-discovery", () => ({
  resolveProviderDiscoveryPayload: vi.fn(),
}));

vi.mock("@/lib/provider-account-discovery-refresh", () => ({
  refreshProviderDiscoveryPayload: vi.fn(),
}));

vi.mock("@/lib/provider-account-snapshots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/provider-account-snapshots")>();
  return {
    ...actual,
    readProviderAccountSnapshot: vi.fn(),
  };
});

const access = await import("@/lib/access");
const businessMode = await import("@/lib/business-mode.server");
const integrations = await import("@/lib/integrations");
const metaAdAccounts = await import("@/lib/meta-ad-accounts");
const discovery = await import("@/lib/provider-account-discovery");
const refresh = await import("@/lib/provider-account-discovery-refresh");
const snapshots = await import("@/lib/provider-account-snapshots");
const { POST } = await import("@/app/integrations/meta/ad-accounts/route");

describe("POST /integrations/meta/ad-accounts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      access_token: "meta-token",
      token_expires_at: null,
    } as never);
    vi.mocked(snapshots.readProviderAccountSnapshot).mockResolvedValue(null as never);
  });

  it("serves cached Meta account discovery data when manual refresh fails", async () => {
    vi.mocked(refresh.refreshProviderDiscoveryPayload).mockRejectedValue(
      new snapshots.ProviderAccountSnapshotRefreshError({
        businessId: "biz_1",
        provider: "meta",
        message: "Meta API temporarily unavailable.",
      }),
    );
    vi.mocked(discovery.resolveProviderDiscoveryPayload).mockResolvedValue({
      data: [
        {
          id: "act_1",
          name: "Cached Account",
          assigned: true,
        },
      ],
      meta: {
        source: "snapshot",
        sourceHealth: "stale_cached",
        fetchedAt: "2026-05-14T12:00:00.000Z",
        stale: true,
        refreshFailed: true,
        failureClass: "unknown",
        lastError: "Meta API temporarily unavailable.",
        lastKnownGoodAvailable: true,
        refreshRequestedAt: null,
        lastRefreshAttemptAt: "2026-05-14T12:05:00.000Z",
        nextRefreshAfter: null,
        retryAfterAt: null,
        refreshInProgress: false,
        sourceReason: "assignment_drawer_manual_refresh",
        trustLevel: "risky",
        trustScore: 42,
        snapshotAgeHours: 1,
        lastSuccessfulRefreshAgeHours: 1,
        refreshFailureStreak: 1,
      },
      notice: "Your accounts list could not be refreshed right now. Showing the last available list.",
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/integrations/meta/ad-accounts?businessId=biz_1", {
        method: "POST",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data).toEqual([
      {
        id: "act_1",
        name: "Cached Account",
        assigned: true,
      },
    ]);
    expect(payload.notice).toBe(
      "Your accounts list could not be refreshed right now. Showing the last available list.",
    );
  });

  it("allows direct Meta accounts on first refresh when business discovery fails without a cached snapshot", async () => {
    vi.mocked(metaAdAccounts.fetchMetaAdAccounts).mockResolvedValue({
      status: 200,
      ok: false,
      rawBody: "{}",
      body: {
        error: {
          message: "Meta business account discovery failed: Missing business permission",
        },
      },
      normalized: [
        {
          id: "act_direct",
          raw_id: "direct",
          name: "Direct Account",
          currency: "USD",
          timezone: "America/New_York",
          account_status: 1,
          source: "direct",
        },
      ],
      businessDiscovery: {
        status: 403,
        ok: false,
        businessCount: 0,
        accountCount: 0,
        errors: [{ edge: "me/businesses", message: "Missing business permission" }],
      },
    } as never);
    vi.mocked(refresh.refreshProviderDiscoveryPayload).mockImplementationOnce(async (input) => {
      const accounts = await input.liveLoader();
      return {
        data: accounts.map((account) => ({ ...account, assigned: false })),
        meta: {
          source: "live",
          sourceHealth: "fresh",
          fetchedAt: "2026-05-14T12:00:00.000Z",
          stale: false,
          refreshFailed: false,
          failureClass: null,
          lastError: null,
          lastKnownGoodAvailable: true,
          refreshRequestedAt: null,
          lastRefreshAttemptAt: null,
          nextRefreshAfter: null,
          retryAfterAt: null,
          refreshInProgress: false,
          sourceReason: "assignment_drawer_manual_refresh",
          trustLevel: "safe",
          trustScore: 100,
          snapshotAgeHours: 0,
          lastSuccessfulRefreshAgeHours: 0,
          refreshFailureStreak: 0,
        },
        notice: null,
      } as never;
    });

    const response = await POST(
      new NextRequest("http://localhost/integrations/meta/ad-accounts?businessId=biz_1", {
        method: "POST",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data).toEqual([
      {
        id: "act_direct",
        name: "Direct Account",
        currency: "USD",
        timezone: "America/New_York",
        isManager: false,
        assigned: false,
      },
    ]);
  });
});
