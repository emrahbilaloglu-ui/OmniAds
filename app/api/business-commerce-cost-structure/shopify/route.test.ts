import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const mocks = vi.hoisted(() => ({
  requireBusinessAccess: vi.fn(),
  rejectIfReviewerReadOnly: vi.fn(),
  rejectIfMetaOperatorDemoWrite: vi.fn(),
  getIntegration: vi.fn(),
  getShopifyUnitCostCatalog: vi.fn(),
  syncShopifyUnitCosts: vi.fn(),
}));

vi.mock("@/lib/access", () => ({ requireBusinessAccess: mocks.requireBusinessAccess }));
vi.mock("@/lib/meta/reviewer-write-guard", () => ({
  rejectIfReviewerReadOnly: mocks.rejectIfReviewerReadOnly,
}));
vi.mock("@/app/api/meta/demo-write-authority", () => ({
  rejectIfMetaOperatorDemoWrite: mocks.rejectIfMetaOperatorDemoWrite,
}));
vi.mock("@/lib/integrations", () => ({ getIntegration: mocks.getIntegration }));
vi.mock("@/lib/shopify/admin", () => ({
  hasShopifyScope: (scopes: string | null | undefined, scope: string) =>
    String(scopes ?? "").split(/[,\s]+/).includes(scope),
}));
vi.mock("@/lib/shopify/unit-cost-catalog", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shopify/unit-cost-catalog")>(
    "@/lib/shopify/unit-cost-catalog",
  );
  return {
    ...actual,
    getShopifyUnitCostCatalog: mocks.getShopifyUnitCostCatalog,
    syncShopifyUnitCosts: mocks.syncShopifyUnitCosts,
  };
});

const { GET, POST } = await import(
  "@/app/api/business-commerce-cost-structure/shopify/route"
);

function getRequest(query = `?businessId=${BUSINESS_ID}`) {
  return new NextRequest(`http://localhost/api/business-commerce-cost-structure/shopify${query}`);
}

function postRequest() {
  return new NextRequest("http://localhost/api/business-commerce-cost-structure/shopify", {
    method: "POST",
    body: JSON.stringify({ businessId: BUSINESS_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireBusinessAccess.mockResolvedValue({
    session: { user: { id: "user-1", email: "operator@adsecute.com" } },
    membership: { businessId: BUSINESS_ID, role: "collaborator" },
  });
  mocks.rejectIfReviewerReadOnly.mockReturnValue(null);
  mocks.rejectIfMetaOperatorDemoWrite.mockResolvedValue(null);
  mocks.getIntegration.mockResolvedValue({
    status: "connected",
    provider_account_id: "store.myshopify.com",
    access_token: "token",
    scopes: "read_products,read_inventory",
  });
  mocks.getShopifyUnitCostCatalog.mockResolvedValue({
    storage: { ready: true, missingTables: [] },
    summary: { totalVariants: 2, costedVariants: 1, missingCostVariants: 1 },
    rows: [],
    matchedVariants: 2,
    limit: 50,
    offset: 0,
  });
  mocks.syncShopifyUnitCosts.mockResolvedValue({ totalVariants: 2 });
});

describe("Shopify cost catalog route", () => {
  it("scopes reads to the authorized business and returns connection readiness", async () => {
    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getShopifyUnitCostCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, limit: 50, offset: 0 }),
    );
    expect(body.connection).toMatchObject({
      connected: true,
      scopeReady: true,
      shopDomain: "store.myshopify.com",
    });
  });

  it("refuses reviewer writes before making a Shopify request", async () => {
    mocks.rejectIfReviewerReadOnly.mockReturnValue(
      NextResponse.json({ error: "reviewer_read_only" }, { status: 403 }),
    );

    const response = await POST(postRequest());

    expect(response.status).toBe(403);
    expect(mocks.syncShopifyUnitCosts).not.toHaveBeenCalled();
  });

  it("returns the refreshed catalog after a complete sync", async () => {
    const response = await POST(postRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.syncShopifyUnitCosts).toHaveBeenCalledWith(BUSINESS_ID);
    expect(body).toMatchObject({
      summary: { totalVariants: 2 },
      sync: { totalVariants: 2 },
    });
  });
});
