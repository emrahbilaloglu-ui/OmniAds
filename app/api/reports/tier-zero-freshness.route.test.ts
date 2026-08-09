import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/custom-report-store", () => ({
  listCustomReportsByBusiness: vi.fn(),
  createCustomReport: vi.fn(),
}));

import { GET } from "@/app/api/reports/route";
import { requireBusinessAccess } from "@/lib/access";
import { listCustomReportsByBusiness } from "@/lib/custom-report-store";

/**
 * The read route behind a Tier-0 surface, checked for the one failure that
 * matters to freshness: answering a broken read with a cheerful empty result.
 *
 * "No reports" and "we could not find out whether there are reports" look
 * identical on screen unless the route keeps them apart, and the surface can
 * only be honest about staleness if the route is honest about failure first.
 */
function reportsRequest(query: string) {
  return new NextRequest(`http://localhost/api/reports${query}`);
}

describe("the reports read route and the freshness contract", () => {
  beforeEach(() => {
    vi.mocked(requireBusinessAccess).mockResolvedValue({
      userId: "user-1",
      role: "owner",
    } as never);
    vi.mocked(listCustomReportsByBusiness).mockReset();
  });

  it("names a missing scope rather than answering for an unspecified business", () => {
    return GET(reportsRequest("")).then(async (response) => {
      expect(response.status).toBe(400);
      const body = await response.json();
      // A bounded code the surface can map to a message, not a raw string.
      expect(body.error).toBe("business_id_required");
    });
  });

  it("does not answer a failed read with an empty list and a 200", async () => {
    vi.mocked(listCustomReportsByBusiness).mockRejectedValue(
      new Error("connection terminated unexpectedly"),
    );

    // The route must not swallow this. A resolved 200 carrying `reports: []`
    // is the exact bug: the surface would render "no reports yet" and the
    // operator would believe it.
    await expect(GET(reportsRequest("?businessId=biz-1"))).rejects.toThrow(
      "connection terminated unexpectedly",
    );
  });

  it("distinguishes a genuinely empty result from a failed one", async () => {
    vi.mocked(listCustomReportsByBusiness).mockResolvedValue([]);
    const response = await GET(reportsRequest("?businessId=biz-1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reports: [] });
  });

  it("carries the per-report timestamp the surface dates itself from", async () => {
    // The Reports surface reports its as-of from the newest row it received.
    // If the route stopped sending updatedAt, the surface would silently fall
    // back to "date unknown" rather than showing a wrong date -- but the chip
    // would stop being useful, so the field is part of the contract.
    vi.mocked(listCustomReportsByBusiness).mockResolvedValue([
      { id: "r-1", name: "Weekly", updatedAt: "2026-08-09T04:00:00.000Z" },
      { id: "r-2", name: "Monthly", updatedAt: "2026-08-01T04:00:00.000Z" },
    ] as never);

    const response = await GET(reportsRequest("?businessId=biz-1"));
    const body = await response.json();
    expect(body.reports[0].updatedAt).toBe("2026-08-09T04:00:00.000Z");
  });

  it("refuses before reading when access is denied", async () => {
    const denied = Response.json(
      { error: "forbidden" },
      { status: 403 },
    );
    vi.mocked(requireBusinessAccess).mockResolvedValue({
      error: denied,
    } as never);

    const response = await GET(reportsRequest("?businessId=biz-1"));
    expect(response.status).toBe(403);
    // A 403 must never reach the store; an unauthorised read that returned []
    // would render as an empty account.
    expect(listCustomReportsByBusiness).not.toHaveBeenCalled();
  });
});
