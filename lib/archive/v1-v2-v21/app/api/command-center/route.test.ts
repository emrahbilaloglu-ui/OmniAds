import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/command-center-config", () => ({
  isCommandCenterV1EnabledForBusiness: vi.fn(),
}));

vi.mock("@/lib/command-center-service", () => ({
  getCommandCenterSnapshot: vi.fn(),
}));

vi.mock("@/lib/command-center-store", () => ({
  getCommandCenterPermissions: vi.fn(),
}));

const access = await import("@/lib/access");
const config = await import("@/lib/command-center-config");
const service = await import("@/lib/command-center-service");
const store = await import("@/lib/command-center-store");
const { GET } = await import("@/app/api/command-center/route");

describe("GET /api/command-center", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {
        user: {
          id: "user_1",
          email: "operator@adsecute.com",
        },
      } as never,
      membership: {
        role: "collaborator",
      } as never,
    });
    vi.mocked(config.isCommandCenterV1EnabledForBusiness).mockReturnValue(true);
    vi.mocked(store.getCommandCenterPermissions).mockReturnValue({
      canEdit: true,
      reason: null,
      role: "collaborator",
    });
    vi.mocked(service.getCommandCenterSnapshot).mockResolvedValue({
      contractVersion: "command-center.v1",
      generatedAt: "2026-04-11T00:00:00.000Z",
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      analyticsWindow: {
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        role: "analysis_only",
      },
      decisionWindows: {
        recent7d: {
          key: "recent7d",
          label: "recent 7d",
          startDate: "2026-04-04",
          endDate: "2026-04-10",
          days: 7,
          role: "recent_watch",
        },
        primary30d: {
          key: "primary30d",
          label: "primary 30d",
          startDate: "2026-03-12",
          endDate: "2026-04-10",
          days: 30,
          role: "decision_authority",
        },
        baseline90d: {
          key: "baseline90d",
          label: "baseline 90d",
          startDate: "2026-01-11",
          endDate: "2026-04-10",
          days: 90,
          role: "historical_memory",
        },
      },
      historicalMemory: {
        available: true,
        source: "rolling_baseline",
        baselineWindowKey: "baseline90d",
        startDate: "2026-01-11",
        endDate: "2026-04-10",
        lookbackDays: 90,
        note: "Decisions use live rolling windows with baseline memory instead of the selected period.",
      },
      decisionAsOf: "2026-04-10",
      activeViewKey: "today_priorities",
      permissions: {
        canEdit: true,
        reason: null,
        role: "collaborator",
      },
      summary: {
        totalActions: 3,
        actionCoreCount: 2,
        pendingCount: 2,
        approvedCount: 1,
        rejectedCount: 0,
        snoozedCount: 0,
        assignedCount: 1,
        watchlistCount: 1,
        archiveCount: 0,
        degradedCount: 1,
      },
      throughput: {
        totalBudget: 12,
        quotas: { critical: 4, high: 4, medium: 3, low: 1 },
        selectedActionFingerprints: [],
        overflowCount: 1,
        actionableCount: 3,
        selectedCount: 2,
      },
      ownerWorkload: [],
      shiftDigest: {
        generatedAt: "2026-04-11T00:00:00.000Z",
        headline: "2 actions fit the current shift budget.",
        summary: "No owner hotspots are active in the current queue.",
        blockers: [],
        watchouts: [],
        linkedActionFingerprints: [],
      },
      viewStacks: [],
      feedbackSummary: {
        totalCount: 2,
        falsePositiveCount: 1,
        badRecommendationCount: 0,
        falseNegativeCount: 1,
        queueGapCount: 1,
        recentEntries: [],
      },
      historicalIntelligence: {
        selectedWindow: {
          startDate: "2026-04-01",
          endDate: "2026-04-10",
          note: "Analysis only. Live decisions and queue selection continue to use the primary decision window.",
        },
        campaignFamilies: [],
        decisionQuality: {
          actionableCount: 3,
          selectedCount: 2,
          overflowCount: 1,
          queueGapCount: 1,
          feedbackCount: 2,
          falsePositiveCount: 1,
          falseNegativeCount: 1,
          badRecommendationCount: 0,
          suppressionRates: {
            actionCore: 0.67,
            watchlist: 0.33,
            archive: 0,
            degraded: 0.33,
          },
          falsePositiveHotspots: [],
          falseNegativeHotspots: [],
        },
        degradedGuidance: {
          degradedActionCount: 1,
          missingInputs: ["target pack"],
          reasons: ["Target pack missing"],
          summary: "Missing truth still caps 1 surfaced action.",
        },
        calibrationSuggestions: [],
      },
      actions: [],
      savedViews: [],
      journal: [],
      handoffs: [],
      feedback: [],
      assignableUsers: [],
    } as never);
  });

  it("returns the typed command center payload", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/command-center?businessId=biz&startDate=2026-04-01&endDate=2026-04-10&viewKey=today_priorities",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.contractVersion).toBe("command-center.v1");
    expect(service.getCommandCenterSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        activeViewKey: "today_priorities",
      }),
    );
  });

  it("returns 404 when the feature gate is disabled", async () => {
    vi.mocked(config.isCommandCenterV1EnabledForBusiness).mockReturnValue(false);

    const response = await GET(
      new NextRequest("http://localhost/api/command-center?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error).toBe("command_center_disabled");
  });
});
