import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * A share link must reproduce the period the operator reviewed on screen.
 *
 * Before this slice the share route re-rendered the report's stored trailing
 * preset, so an operator who scoped the view to a specific week could hand a
 * client a link showing a different window than the one they approved.
 */

const renderCustomReportRecord = vi.hoisted(() => vi.fn());
const createCustomReportShareSnapshot = vi.hoisted(() => vi.fn());
const getCustomReportById = vi.hoisted(() => vi.fn());

vi.mock("@/lib/custom-report-renderer", () => ({ renderCustomReportRecord }));
vi.mock("@/lib/custom-report-store", () => ({
  createCustomReportShareSnapshot,
  getCustomReportById,
}));
vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(async () => ({
    session: { user: { id: "user_1" } },
  })),
  listUserBusinesses: vi.fn(async () => [
    { id: "biz_1", name: "Grandmix", currency: "TRY" },
  ]),
}));

import { POST } from "@/app/api/reports/[reportId]/share/route";

function shareRequest(body: unknown) {
  return {
    json: async () => body,
    headers: new Headers(),
  } as unknown as Parameters<typeof POST>[0];
}

describe("report share period fidelity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCustomReportById.mockResolvedValue({
      id: "rep_1",
      businessId: "biz_1",
      name: "One Click Paid Media",
      description: null,
      definition: { dateRangePreset: "30", compareMode: "none", widgets: [] },
    });
    renderCustomReportRecord.mockResolvedValue({
      businessId: "biz_1",
      name: "One Click Paid Media",
      dateRangeLabel: "label",
      generatedAt: "2026-08-08T00:00:00.000Z",
      widgets: [],
    });
    createCustomReportShareSnapshot.mockResolvedValue({
      token: "tok_1",
      expiresAt: "2026-08-15T00:00:00.000Z",
    });
  });

  it("renders the on-screen window into the shared snapshot", async () => {
    await POST(shareRequest({ expiryDays: 7, startDate: "2026-07-01", endDate: "2026-07-07" }), {
      params: Promise.resolve({ reportId: "rep_1" }),
    });

    expect(renderCustomReportRecord).toHaveBeenCalledTimes(1);
    const options = renderCustomReportRecord.mock.calls[0][2];
    expect(options.startDateOverride).toBe("2026-07-01");
    expect(options.endDateOverride).toBe("2026-07-07");
  });

  it("passes the business currency so the client report is not denominated in dollars", async () => {
    await POST(shareRequest({ expiryDays: 7, startDate: "2026-07-01", endDate: "2026-07-07" }), {
      params: Promise.resolve({ reportId: "rep_1" }),
    });

    expect(renderCustomReportRecord.mock.calls[0][2].currency).toBe("TRY");
  });

  it("falls back to the stored definition only when no window is supplied", async () => {
    await POST(shareRequest({ expiryDays: 7 }), {
      params: Promise.resolve({ reportId: "rep_1" }),
    });

    const options = renderCustomReportRecord.mock.calls[0][2];
    expect(options.startDateOverride).toBeUndefined();
    expect(options.endDateOverride).toBeUndefined();
  });

  it("ignores a malformed window rather than rendering an invalid period", async () => {
    await POST(shareRequest({ expiryDays: 7, startDate: "last-week", endDate: "today" }), {
      params: Promise.resolve({ reportId: "rep_1" }),
    });

    const options = renderCustomReportRecord.mock.calls[0][2];
    expect(options.startDateOverride).toBeUndefined();
    expect(options.endDateOverride).toBeUndefined();
  });

  it("requires both ends of the window before overriding", async () => {
    await POST(shareRequest({ expiryDays: 7, startDate: "2026-07-01" }), {
      params: Promise.resolve({ reportId: "rep_1" }),
    });

    const options = renderCustomReportRecord.mock.calls[0][2];
    expect(options.startDateOverride).toBeUndefined();
  });
});
