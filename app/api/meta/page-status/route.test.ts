import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/meta/page-status/route";

/*
 * The tri-state posture read, at its one database read.
 *
 * The route no longer asks `isDemoBusiness`, which manufactured "live" from a
 * database it could not read. It asks `readMetaBusinessDataPosture`, which
 * reads `businesses.is_demo_business` through this module and answers
 * `unverified` when it cannot — and `getDb()` throws under vitest, so without
 * this the route would correctly refuse every case in this file.
 */
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(async () => "live"),
}));
vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/demo-business", () => ({
  isDemoBusinessId: vi.fn(),
  getDemoMetaStatus: vi.fn(),
}));

vi.mock("@/lib/meta/account-context", () => ({
  getMetaAccountContext: vi.fn(),
}));

vi.mock("@/lib/meta/authoritative-finalization-config", () => ({
  isMetaAuthoritativeFinalizationV2EnabledForBusiness: vi.fn(),
}));

vi.mock("@/lib/meta/readiness", () => ({
  getMetaPartialReason: vi.fn(),
  getMetaRangePreparationContext: vi.fn(),
}));

vi.mock("@/lib/meta/historical-verification", () => ({
  getMetaHistoricalVerificationReason: vi.fn(),
}));

vi.mock("@/lib/meta/warehouse", () => ({
  getLatestMetaSyncHealth: vi.fn(),
  getMetaAccountDailyCoverage: vi.fn(),
  getMetaCampaignDailyCoverage: vi.fn(),
  getMetaQueueHealth: vi.fn(),
}));

vi.mock("@/lib/sync/meta-sync", () => ({
  getMetaSelectedRangeTruthReadiness: vi.fn(),
}));

const demoAuthority = await import("@/app/api/launchpad/meta/demo-write-authority");
const access = await import("@/lib/access");
const demoBusiness = await import("@/lib/demo-business");
const accountContext = await import("@/lib/meta/account-context");
const finalizationConfig = await import("@/lib/meta/authoritative-finalization-config");
const readiness = await import("@/lib/meta/readiness");
const historicalVerification = await import("@/lib/meta/historical-verification");
const warehouse = await import("@/lib/meta/warehouse");
const metaSync = await import("@/lib/sync/meta-sync");

describe("GET /api/meta/page-status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T12:00:00.000Z"));
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(demoBusiness.isDemoBusinessId).mockReturnValue(false);
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue("live");
    vi.mocked(accountContext.getMetaAccountContext).mockResolvedValue({
      businessId: "biz",
      connected: true,
      accessToken: "token",
      connectionGeneration: "1:connected",
      accountIds: ["act_1"],
      primaryAccountId: "act_1",
      primaryAccountTimezone: "UTC",
      currency: "USD",
      accountProfiles: {
        act_1: {
          currency: "USD",
          timezone: "UTC",
          name: "Main account",
        },
      },
    });
    vi.mocked(readiness.getMetaPartialReason).mockReturnValue(
      "Current-day Meta data is still being prepared.",
    );
    vi.mocked(historicalVerification.getMetaHistoricalVerificationReason).mockReturnValue(
      "Summary and campaign data are still being prepared for the selected range.",
    );
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 0,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);
    vi.mocked(warehouse.getLatestMetaSyncHealth).mockResolvedValue({
      progressPercent: 100,
      completedDays: 7,
      totalDays: 7,
      readyThroughDate: "2026-04-05",
    } as never);
    vi.mocked(finalizationConfig.isMetaAuthoritativeFinalizationV2EnabledForBusiness).mockReturnValue(true);
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: true,
      state: "ready",
      verificationState: "finalized_verified",
      completedCoreDays: 5,
      totalDays: 5,
    } as never);
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 5,
      ready_through_date: "2026-04-05",
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 5,
      ready_through_date: "2026-04-05",
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a current-day preparing contract without making breakdowns page-blocking", async () => {
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      isSelectedCurrentDay: true,
      selectedRangeIncludesCurrentDay: false,
      selectedRangeHistoricalEndDate: "2026-04-20",
      selectedRangeTruthEndDate: "2026-04-20",
      currentDateInTimezone: "2026-04-20",
      primaryAccountTimezone: "UTC",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "current_day_live",
      breakdownReadMode: "current_day_live",
    });
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 2,
      leasedPartitions: 1,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 0,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);
    vi.mocked(warehouse.getLatestMetaSyncHealth).mockResolvedValue({
      progressPercent: 25,
      completedDays: 0,
      totalDays: 1,
      readyThroughDate: null,
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/page-status?businessId=biz&startDate=2026-04-20&endDate=2026-04-20"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe("syncing");
    expect(payload.pageReadiness.selectedRangeMode).toBe("current_day_live");
    expect(payload.pageReadiness.requiredSurfaces.summary.state).toBe("syncing");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.age"].countsForPageCompleteness).toBe(false);
    expect(payload.jobHealth.queueDepth).toBe(2);
    expect(payload.latestSync.progressPercent).toBe(25);
  });

  it("returns the current Meta account day even without a selected range", async () => {
    vi.mocked(accountContext.getMetaAccountContext).mockResolvedValue({
      businessId: "biz",
      connected: true,
      accessToken: "token",
      connectionGeneration: "1:connected",
      accountIds: ["act_1"],
      primaryAccountId: "act_1",
      primaryAccountTimezone: "America/Los_Angeles",
      currency: "USD",
      accountProfiles: {
        act_1: {
          currency: "USD",
          timezone: "America/Los_Angeles",
          name: "Main account",
        },
      },
    });

    const response = await GET(
      new NextRequest("http://localhost/api/meta/page-status?businessId=biz")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.primaryAccountTimezone).toBe("America/Los_Angeles");
    expect(payload.currentDateInTimezone).toBe("2026-04-20");
  });

  it("returns a ready historical core contract when coverage and truth are complete", async () => {
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      isSelectedCurrentDay: false,
      selectedRangeIncludesCurrentDay: false,
      selectedRangeHistoricalEndDate: "2026-04-05",
      selectedRangeTruthEndDate: "2026-04-05",
      currentDateInTimezone: "2026-04-20",
      primaryAccountTimezone: "UTC",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "historical_authoritative",
      breakdownReadMode: "historical_authoritative",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/page-status?businessId=biz&startDate=2026-04-01&endDate=2026-04-05"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe("ready");
    expect(payload.readinessLevel).toBe("ready");
    expect(payload.coreReadiness.percent).toBe(100);
    expect(payload.pageReadiness.state).toBe("ready");
    expect(payload.domainReadiness.blockingSurfaces).toEqual([]);
    expect(payload.warehouse.coverage.selectedRange).toMatchObject({
      completedDays: 5,
      totalDays: 5,
      isComplete: true,
    });
  });
});
