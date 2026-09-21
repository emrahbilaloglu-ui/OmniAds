import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  requireBusinessAccess: vi.fn(),
  readBreakEvenPreviewFacts: vi.fn(),
  buildBreakEvenRoasPreview: vi.fn(),
}));

vi.mock("@/lib/access", () => ({ requireBusinessAccess: mocks.requireBusinessAccess }));
vi.mock("@/lib/commerce-cost/break-even-preview-source", () => ({
  readBreakEvenPreviewFacts: mocks.readBreakEvenPreviewFacts,
}));
vi.mock("@/lib/commerce-cost/break-even-preview", async () => {
  const actual = await vi.importActual<typeof import("@/lib/commerce-cost/break-even-preview")>(
    "@/lib/commerce-cost/break-even-preview",
  );
  return { ...actual, buildBreakEvenRoasPreview: mocks.buildBreakEvenRoasPreview };
});

const { POST } = await import("@/app/api/business-commerce-break-even-preview/route");
const { structure } = await import("@/lib/commerce-cost/__tests__/fixtures");

function request(body: unknown) {
  return new NextRequest("http://localhost/api/business-commerce-break-even-preview", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function validBody() {
  return {
    businessId: BUSINESS_ID,
    startDate: "2026-08-25",
    endDate: "2026-09-21",
    structure: structure({ businessId: "client-must-not-own-this" }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireBusinessAccess.mockResolvedValue({
    session: { user: { id: "user-1", email: "reader@adsecute.com" } },
    membership: { businessId: BUSINESS_ID, role: "guest" },
  });
  mocks.readBreakEvenPreviewFacts.mockResolvedValue({
    window: { startDate: "2026-08-25", endDate: "2026-09-21", days: 28 },
    reportingCurrency: "TRY",
    baseTotals: {},
    orderCount: null,
    unitCount: null,
    lineCount: null,
    currencyMismatchNetSales: null,
    shopify: {
      available: false,
      unavailableReason: "not needed",
      currentUnitCostTotal: null,
      costedNetSales: null,
      missingNetSales: null,
      latestObservedAt: null,
    },
  });
  mocks.buildBreakEvenRoasPreview.mockReturnValue({
    status: "ready",
    breakEvenRoas: 2.5,
    variableCostRate: 0.6,
    contributionMarginRate: 0.4,
    window: { startDate: "2026-08-25", endDate: "2026-09-21", days: 28 },
    reportingCurrency: "TRY",
    contributions: [],
    blockers: [],
    assumptions: [],
  });
});

describe("POST break-even preview", () => {
  it("authorizes a read and calculates an unsaved structure without writing it", async () => {
    const response = await POST(request(validBody()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preview.breakEvenRoas).toBe(2.5);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, minRole: "guest" }),
    );
    expect(mocks.readBreakEvenPreviewFacts).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      startDate: "2026-08-25",
      endDate: "2026-09-21",
      reportingCurrency: "TRY",
    });
    expect(mocks.buildBreakEvenRoasPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        structure: expect.objectContaining({ businessId: BUSINESS_ID }),
      }),
    );
  });

  it("returns the access refusal before reading commerce facts", async () => {
    mocks.requireBusinessAccess.mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });

    const response = await POST(request(validBody()));
    expect(response.status).toBe(403);
    expect(mocks.readBreakEvenPreviewFacts).not.toHaveBeenCalled();
  });

  it("rejects an invalid date window", async () => {
    const response = await POST(request({ ...validBody(), startDate: "2026-09-22" }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_window" });
    expect(mocks.readBreakEvenPreviewFacts).not.toHaveBeenCalled();
  });

  it("rejects an unreadable draft instead of coercing it", async () => {
    const response = await POST(request({ ...validBody(), structure: { components: [] } }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_cost_structure" });
    expect(mocks.readBreakEvenPreviewFacts).not.toHaveBeenCalled();
  });
});
