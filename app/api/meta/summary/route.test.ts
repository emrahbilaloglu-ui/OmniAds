import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/meta/summary/route";
import { assertMetaSummaryPageContract } from "@/lib/meta/page-route-contract.test-helpers";

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

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));

vi.mock("@/lib/meta/canonical-overview", () => ({
  getMetaCanonicalOverviewSummary: vi.fn(),
}));

vi.mock("@/lib/demo-business", () => ({
  isDemoBusinessId: vi.fn(() => false),
  getDemoMetaSummary: vi.fn(),
}));

const demoAuthority = await import("@/app/api/launchpad/meta/demo-write-authority");
const access = await import("@/lib/access");
const assignments = await import("@/lib/provider-account-assignments");
const canonical = await import("@/lib/meta/canonical-overview");

describe("GET /api/meta/summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    // Re-armed per case: a case that proves the demo or unverified branch
    // replaces this implementation, and without this the next case would
    // inherit that workspace's posture.
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue("live");
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1"],
    } as never);
    vi.mocked(canonical.getMetaCanonicalOverviewSummary).mockResolvedValue({
      totals: {
        spend: 1200,
        revenue: 3600,
        cpa: 24,
        roas: 3,
      },
      isPartial: false,
      notReadyReason: null,
      readSource: "warehouse",
    } as never);
  });

  /*
   * §6.2. The posture read is the first thing that can refuse, and it refuses
   * BEFORE the source is asked — so an unreadable workspace flag never becomes
   * a provider read whose answer is then served as live fact.
   */
  it("withholds the summary when the workspace posture cannot be read", async () => {
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue(
      "unverified",
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/summary?businessId=biz&startDate=2026-04-01&endDate=2026-04-03",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error).toBe("workspace_posture_unverified");
    // Not an empty screen: the envelope says "not ready", so a client that
    // renders the body rather than the status still says so.
    expect(payload.isPartial).toBe(true);
    expect(payload.notReadyReason).toBeTruthy();
    // ...and nothing was read on the way to that refusal.
    expect(canonical.getMetaCanonicalOverviewSummary).not.toHaveBeenCalled();
  });

  it("serves the demo fixture for a confirmed demo workspace, and reads no live source", async () => {
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue("demo");

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/summary?businessId=biz&startDate=2026-04-01&endDate=2026-04-03",
      ),
    );

    expect(response.status).toBe(200);
    expect(canonical.getMetaCanonicalOverviewSummary).not.toHaveBeenCalled();
  });

  it("returns the KPI-visible totals subset for historical requests", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/summary?businessId=biz&startDate=2026-04-01&endDate=2026-04-03"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    assertMetaSummaryPageContract(payload);
    expect(canonical.getMetaCanonicalOverviewSummary).toHaveBeenCalledTimes(1);
  });

  it("keeps current-day summary aligned with the live override when live totals are actually available", async () => {
    vi.mocked(canonical.getMetaCanonicalOverviewSummary).mockResolvedValue({
      totals: {
        spend: 55,
        revenue: 160,
        cpa: 11,
        roas: 2.91,
        impressions: 2400,
      },
      isPartial: false,
      notReadyReason: null,
      readSource: "current_day_live",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/summary?businessId=biz&startDate=2026-04-05&endDate=2026-04-05"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    assertMetaSummaryPageContract(payload);
    expect(payload.totals).toEqual(
      expect.objectContaining({
        spend: 55,
        revenue: 160,
        cpa: 11,
        roas: 2.91,
      })
    );
  });

  it("keeps the current-day payload partial instead of falling back to warehouse totals", async () => {
    vi.mocked(canonical.getMetaCanonicalOverviewSummary).mockResolvedValue({
      totals: {
        spend: 0,
        revenue: 0,
        cpa: null,
        roas: 0,
      },
      isPartial: true,
      notReadyReason: "Current-day live Meta totals are still being prepared.",
      readSource: "current_day_live",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/summary?businessId=biz&startDate=2026-04-05&endDate=2026-04-05"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    assertMetaSummaryPageContract(payload);
    expect(payload.totals).toEqual(
      expect.objectContaining({
        spend: 0,
        revenue: 0,
        cpa: null,
        roas: 0,
      })
    );
  });
});
