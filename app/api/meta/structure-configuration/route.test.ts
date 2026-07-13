import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/meta/structure-configuration/route";

const accessMock = vi.hoisted(() => ({
  requireBusinessAccess: vi.fn(),
}));
const assignmentsMock = vi.hoisted(() => ({
  getProviderAccountAssignments: vi.fn(),
}));
const storeMock = vi.hoisted(() => ({
  readLatestMetaAdSetConfigHistory: vi.fn(),
  readLatestMetaCampaignConfigHistory: vi.fn(),
  readMetaAdSetDimensions: vi.fn(),
  readMetaCampaignDimensions: vi.fn(),
  readPreviousDifferentMetaAdSetConfigHistoryDiffs: vi.fn(),
  readPreviousDifferentMetaCampaignConfigHistoryDiffs: vi.fn(),
}));

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: accessMock.requireBusinessAccess,
}));
vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments:
    assignmentsMock.getProviderAccountAssignments,
}));
vi.mock("@/lib/meta/request-model-store", () => storeMock);

describe("GET /api/meta/structure-configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.requireBusinessAccess.mockResolvedValue({
      session: { user: { email: "operator@example.com" } },
      membership: { role: "collaborator" },
    });
    assignmentsMock.getProviderAccountAssignments.mockResolvedValue({
      account_ids: ["act_1"],
    });
    storeMock.readMetaCampaignDimensions.mockResolvedValue(
      new Map([
        ["cmp_1", { providerAccountId: "act_1" }],
      ]),
    );
    storeMock.readLatestMetaCampaignConfigHistory.mockResolvedValue(
      new Map([
        [
          "cmp_1",
          {
            bidStrategyType: "cost_cap",
            bidStrategyLabel: "Cost cap",
            bidValue: 2500,
            bidValueFormat: "currency",
            dailyBudget: 10000,
            lifetimeBudget: null,
          },
        ],
      ]),
    );
    storeMock.readPreviousDifferentMetaCampaignConfigHistoryDiffs.mockResolvedValue(
      new Map([
        [
          "cmp_1",
          {
            previousBidValue: 2000,
            previousBidValueFormat: "currency",
            previousBidCapturedAt: "2026-07-08T09:30:00.000Z",
          },
        ],
      ]),
    );
  });

  it("returns account-scoped current and previous bid values in display units", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/structure-configuration?businessId=biz_1&providerAccountId=act_1&level=campaign&entityId=cmp_1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.configuration).toMatchObject({
      strategyType: "cost_cap",
      currentValue: 25,
      currentValueFormat: "currency",
      previousValue: 20,
      previousValueFormat: "currency",
      previousValueCapturedAt: "2026-07-08T09:30:00.000Z",
      dailyBudget: 100,
    });
    expect(
      storeMock.readPreviousDifferentMetaCampaignConfigHistoryDiffs,
    ).toHaveBeenCalledWith({
      businessId: "biz_1",
      campaignIds: ["cmp_1"],
      includeBudget: false,
    });
  });

  it("fails closed when the entity belongs to another provider account", async () => {
    storeMock.readMetaCampaignDimensions.mockResolvedValue(
      new Map([["cmp_1", { providerAccountId: "act_other" }]]),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/structure-configuration?businessId=biz_1&providerAccountId=act_1&level=campaign&entityId=cmp_1",
      ),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "structure_configuration_unavailable",
    });
  });

  it("rejects an unassigned provider account before reading history", async () => {
    assignmentsMock.getProviderAccountAssignments.mockResolvedValue({
      account_ids: ["act_other"],
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/structure-configuration?businessId=biz_1&providerAccountId=act_1&level=campaign&entityId=cmp_1",
      ),
    );

    expect(response.status).toBe(403);
    expect(storeMock.readMetaCampaignDimensions).not.toHaveBeenCalled();
  });
});
