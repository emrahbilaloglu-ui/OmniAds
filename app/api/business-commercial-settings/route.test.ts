import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/business-commercial", () => ({
  getBusinessCommercialTruthSnapshot: vi.fn(),
  upsertBusinessCommercialTruthSnapshot: vi.fn(),
}));

vi.mock("@/lib/demo-business", () => ({
  isDemoBusinessId: vi.fn(),
}));

vi.mock("@/lib/meta/snapshot-refresh", () => ({
  requestMetaSnapshotRefreshForBusiness: vi.fn(),
}));

vi.mock("@/lib/reviewer-access", () => ({
  isReviewerEmail: vi.fn(),
}));

const access = await import("@/lib/access");
const commercialTruth = await import("@/lib/business-commercial");
const demoBusiness = await import("@/lib/demo-business");
const snapshotRefresh = await import("@/lib/meta/snapshot-refresh");
const reviewerAccess = await import("@/lib/reviewer-access");
const { GET, PUT } = await import("@/app/api/business-commercial-settings/route");

const snapshotFixture = {
  businessId: "biz",
  targetPack: null,
  countryEconomics: [],
  promoCalendar: [],
  operatingConstraints: null,
  costModelContext: null,
  sectionMeta: {
    targetPack: {
      configured: false,
      itemCount: 0,
      sourceLabel: null,
      updatedAt: null,
      updatedByUserId: null,
    },
    countryEconomics: {
      configured: false,
      itemCount: 0,
      sourceLabel: null,
      updatedAt: null,
      updatedByUserId: null,
    },
    promoCalendar: {
      configured: false,
      itemCount: 0,
      sourceLabel: null,
      updatedAt: null,
      updatedByUserId: null,
    },
    operatingConstraints: {
      configured: false,
      itemCount: 0,
      sourceLabel: null,
      updatedAt: null,
      updatedByUserId: null,
    },
  },
};

describe("business commercial settings route", () => {
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
    vi.mocked(commercialTruth.getBusinessCommercialTruthSnapshot).mockResolvedValue(
      snapshotFixture as never,
    );
    vi.mocked(commercialTruth.upsertBusinessCommercialTruthSnapshot).mockResolvedValue(
      snapshotFixture as never,
    );
    vi.mocked(demoBusiness.isDemoBusinessId).mockReturnValue(false);
    vi.mocked(reviewerAccess.isReviewerEmail).mockReturnValue(false);
    vi.mocked(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).mockResolvedValue({
      ok: true,
      status: "ran",
      businessId: "biz",
      snapshotDate: "2026-05-16",
      reason: "commercial_truth_updated",
      cooldownUntil: "2026-05-16T00:05:00.000Z",
      message: "Meta recommendation snapshot refreshed.",
    });
  });

  it("returns snapshot permissions for GET", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/business-commercial-settings?businessId=biz",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.permissions).toEqual({
      canEdit: true,
      reason: null,
      role: "collaborator",
    });
  });

  it("keeps the seeded reviewer read-only on the canonical demo business", async () => {
    vi.mocked(demoBusiness.isDemoBusinessId).mockReturnValue(true);
    vi.mocked(reviewerAccess.isReviewerEmail).mockReturnValue(true);

    const response = await PUT(
      new NextRequest("http://localhost/api/business-commercial-settings", {
        method: "PUT",
        body: JSON.stringify({
          businessId: "biz",
          snapshot: {},
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe("forbidden");
    expect(commercialTruth.upsertBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
  });

  it("passes collaborator saves through to the upsert helper", async () => {
    const response = await PUT(
      new NextRequest("http://localhost/api/business-commercial-settings", {
        method: "PUT",
        body: JSON.stringify({
          businessId: "biz",
          snapshot: {
            targetPack: {
              targetRoas: 2.8,
              breakEvenRoas: 1.86,
              defaultRiskPosture: "aggressive",
              costStructure: {
                cogsPercent: 0.3,
                shippingPercent: 0.08,
                fulfillmentPercent: 0.05,
                paymentProcessingPercent: 0.03,
              },
            },
            calibrationProfiles: [
              {
                channel: "creative",
                objectiveFamily: "sales",
                bidRegime: "open",
                archetype: "winner_scale",
                targetRoasMultiplier: 1.05,
                breakEvenRoasMultiplier: null,
                targetCpaMultiplier: null,
                breakEvenCpaMultiplier: null,
                confidenceCap: 0.82,
                actionCeiling: "review_hold",
                notes: "Keep creative scaling reviewed.",
              },
            ],
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(commercialTruth.upsertBusinessCommercialTruthSnapshot).toHaveBeenCalledWith({
      businessId: "biz",
      updatedByUserId: "user_1",
      snapshot: {
        targetPack: {
          targetRoas: 2.8,
          breakEvenRoas: 1.86,
          defaultRiskPosture: "aggressive",
          costStructure: {
            cogsPercent: 0.3,
            shippingPercent: 0.08,
            fulfillmentPercent: 0.05,
            paymentProcessingPercent: 0.03,
          },
        },
        calibrationProfiles: [
          {
            channel: "creative",
            objectiveFamily: "sales",
            bidRegime: "open",
            archetype: "winner_scale",
            targetRoasMultiplier: 1.05,
            breakEvenRoasMultiplier: null,
            targetCpaMultiplier: null,
            breakEvenCpaMultiplier: null,
            confidenceCap: 0.82,
            actionCeiling: "review_hold",
            notes: "Keep creative scaling reviewed.",
          },
        ],
      },
    });
    expect(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).toHaveBeenCalledWith({
      businessId: "biz",
      reason: "commercial_truth_updated",
    });
  });
});
