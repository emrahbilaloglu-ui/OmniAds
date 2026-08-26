import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The posture read, stubbed at its own DB read.
 *
 * The source moved off the boolean `isDemoBusiness` onto the tri-state
 * `readMetaBusinessDataPosture`, which fails CLOSED: an unreadable flag
 * withholds rather than falling through to the live reader. The module under
 * test is the source, so only the read it delegates to is replaced.
 */
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(async () => "live"),
}));

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));

vi.mock("@/lib/meta/readiness", () => ({
  getMetaPartialReason: vi.fn(),
  getMetaRangePreparationContext: vi.fn(),
}));

vi.mock("@/lib/meta/serving", () => ({
  getMetaWarehouseAdSets: vi.fn(),
}));

vi.mock("@/lib/meta/live", () => ({
  getMetaLiveAdSets: vi.fn(),
}));

vi.mock("@/lib/sync/meta-sync", () => ({
  getMetaSelectedRangeTruthReadiness: vi.fn(),
}));

const businessMode = await import("@/lib/business-mode.server");
const integrations = await import("@/lib/integrations");
const assignments = await import("@/lib/provider-account-assignments");
const readiness = await import("@/lib/meta/readiness");
const serving = await import("@/lib/meta/serving");
const live = await import("@/lib/meta/live");
const adsetsSource = await import("@/lib/meta/adsets-source");

describe("meta adsets source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
    } as never);
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1"],
    } as never);
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      isSelectedCurrentDay: true,
      selectedRangeIncludesCurrentDay: false,
      selectedRangeHistoricalEndDate: "2026-04-05",
      selectedRangeTruthEndDate: "2026-04-05",
      currentDateInTimezone: "2026-04-05",
      primaryAccountTimezone: "UTC",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "current_day_live",
      breakdownReadMode: "current_day_live",
    } as never);
    vi.mocked(readiness.getMetaPartialReason).mockReturnValue(
      "Current-day live Meta ad set data is still being prepared.",
    );
  });

  it("keeps current-day ad sets live-only when the live path is empty", async () => {
    vi.mocked(live.getMetaLiveAdSets).mockResolvedValue([] as never);

    const payload = await adsetsSource.getMetaAdSetsForRange({
      businessId: "biz",
      campaignId: "cmp_1",
      startDate: "2026-04-05",
      endDate: "2026-04-05",
    });

    expect(payload).toEqual({
      status: "ok",
      rows: [],
      isPartial: true,
      notReadyReason: "Current-day live Meta ad set data is still being prepared.",
      evidenceSource: "unknown",
    });
    expect(serving.getMetaWarehouseAdSets).not.toHaveBeenCalled();
  });
});
