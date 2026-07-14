import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/business-commercial", () => ({
  BusinessCommercialSnapshotConflictError: class BusinessCommercialSnapshotConflictError extends Error {
    readonly code = "commercial_truth_changed";
    constructor(readonly currentRevision: string) {
      super("Commercial truth changed after this editor loaded.");
      this.name = "BusinessCommercialSnapshotConflictError";
    }
  },
  businessCommercialSnapshotRevision: vi.fn(() => "a".repeat(64)),
  getBusinessCommercialTruthSnapshot: vi.fn(),
  reconfirmBusinessTargetPack: vi.fn(),
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
const { GET, POST, PUT } =
  await import("@/app/api/business-commercial-settings/route");

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
    vi.mocked(
      commercialTruth.getBusinessCommercialTruthSnapshot,
    ).mockResolvedValue(snapshotFixture as never);
    vi.mocked(
      commercialTruth.upsertBusinessCommercialTruthSnapshot,
    ).mockResolvedValue(snapshotFixture as never);
    vi.mocked(commercialTruth.reconfirmBusinessTargetPack).mockResolvedValue({
      status: "reconfirmed",
      reason: "target_pack_reconfirmed",
      updatedAt: "2026-07-14T12:00:00.123456Z",
    });
    vi.mocked(demoBusiness.isDemoBusinessId).mockReturnValue(false);
    vi.mocked(reviewerAccess.isReviewerEmail).mockReturnValue(false);
    vi.mocked(
      snapshotRefresh.requestMetaSnapshotRefreshForBusiness,
    ).mockResolvedValue({
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
    expect(
      commercialTruth.upsertBusinessCommercialTruthSnapshot,
    ).not.toHaveBeenCalled();
  });

  it("passes collaborator saves through to the upsert helper", async () => {
    const response = await PUT(
      new NextRequest("http://localhost/api/business-commercial-settings", {
        method: "PUT",
        body: JSON.stringify({
          businessId: "biz",
          expectedRevision: "a".repeat(64),
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
    expect(
      commercialTruth.upsertBusinessCommercialTruthSnapshot,
    ).toHaveBeenCalledWith({
      businessId: "biz",
      updatedByUserId: "user_1",
      expectedRevision: "a".repeat(64),
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
    expect(
      snapshotRefresh.requestMetaSnapshotRefreshForBusiness,
    ).toHaveBeenCalledWith({
      businessId: "biz",
      reason: "commercial_truth_updated",
    });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["primitive", "not-a-snapshot"],
    ["array", []],
  ])("rejects a %s snapshot without writing", async (_label, snapshot) => {
    const body: Record<string, unknown> = {
      businessId: "biz",
      expectedRevision: "a".repeat(64),
    };
    if (snapshot !== undefined) body.snapshot = snapshot;

    const response = await PUT(
      new NextRequest("http://localhost/api/business-commercial-settings", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_snapshot",
    });
    expect(
      commercialTruth.upsertBusinessCommercialTruthSnapshot,
    ).not.toHaveBeenCalled();
    expect(
      snapshotRefresh.requestMetaSnapshotRefreshForBusiness,
    ).not.toHaveBeenCalled();
  });

  it("rejects a stale full-snapshot revision without refreshing", async () => {
    const conflict =
      new commercialTruth.BusinessCommercialSnapshotConflictError(
        "b".repeat(64),
      );
    vi.mocked(
      commercialTruth.upsertBusinessCommercialTruthSnapshot,
    ).mockRejectedValueOnce(conflict);

    const response = await PUT(
      new NextRequest("http://localhost/api/business-commercial-settings", {
        method: "PUT",
        body: JSON.stringify({
          businessId: "biz",
          expectedRevision: "a".repeat(64),
          snapshot: { businessId: "biz" },
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "commercial_truth_changed",
      currentRevision: "b".repeat(64),
    });
    expect(
      snapshotRefresh.requestMetaSnapshotRefreshForBusiness,
    ).not.toHaveBeenCalled();
  });

  it("returns an ordinary PUT target validation error without refreshing", async () => {
    const validationError = Object.assign(
      new Error(
        "targetPack.targetRoas must be a finite number greater than zero or null.",
      ),
      {
        name: "BusinessCommercialInputValidationError",
        code: "invalid_target_pack",
        field: "targetPack.targetRoas",
        reason: "targetPack_targetRoas_must_be_positive_finite",
      },
    );
    vi.mocked(
      commercialTruth.upsertBusinessCommercialTruthSnapshot,
    ).mockRejectedValueOnce(validationError);

    const response = await PUT(
      new NextRequest("http://localhost/api/business-commercial-settings", {
        method: "PUT",
        body: JSON.stringify({
          businessId: "biz",
          expectedRevision: "a".repeat(64),
          snapshot: { targetPack: { targetRoas: 0 } },
        }),
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_target_pack",
      field: "targetPack.targetRoas",
      reason: "targetPack_targetRoas_must_be_positive_finite",
    });
    expect(response.status).toBe(422);
    expect(
      snapshotRefresh.requestMetaSnapshotRefreshForBusiness,
    ).not.toHaveBeenCalled();
  });

  it("reconfirms from only the server version token and refreshes after success", async () => {
    const expectedUpdatedAt = "2026-07-01T09:30:00.123456Z";
    const response = await POST(
      new NextRequest("http://localhost/api/business-commercial-settings", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          action: "reconfirm_target_pack",
          expectedUpdatedAt,
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz", minRole: "collaborator" }),
    );
    expect(commercialTruth.reconfirmBusinessTargetPack).toHaveBeenCalledWith({
      businessId: "biz",
      updatedByUserId: "user_1",
      expectedUpdatedAt,
    });
    expect(
      vi.mocked(commercialTruth.reconfirmBusinessTargetPack).mock.calls[0]?.[0],
    ).toEqual({
      businessId: "biz",
      updatedByUserId: "user_1",
      expectedUpdatedAt,
    });
    expect(
      snapshotRefresh.requestMetaSnapshotRefreshForBusiness,
    ).toHaveBeenCalledWith({
      businessId: "biz",
      reason: "commercial_truth_updated",
    });
    expect(
      commercialTruth.getBusinessCommercialTruthSnapshot,
    ).toHaveBeenCalledWith("biz");
    expect(payload.snapshot).toEqual(snapshotFixture);
    expect(payload.reconfirmation.status).toBe("reconfirmed");
  });

  it.each([
    null,
    "2026-07-14",
    "2026-02-31T00:00:00Z",
    "2026-07-14T12:00:00.1234567Z",
    " 2026-07-14T12:00:00Z",
    "2026-07-14T12:00:00",
  ])(
    "rejects non-strict expectedUpdatedAt value %s",
    async (expectedUpdatedAt) => {
      const response = await POST(
        new NextRequest("http://localhost/api/business-commercial-settings", {
          method: "POST",
          body: JSON.stringify({
            businessId: "biz",
            action: "reconfirm_target_pack",
            expectedUpdatedAt,
          }),
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "invalid_expected_updated_at",
      });
      expect(
        commercialTruth.reconfirmBusinessTargetPack,
      ).not.toHaveBeenCalled();
      expect(
        snapshotRefresh.requestMetaSnapshotRefreshForBusiness,
      ).not.toHaveBeenCalled();
    },
  );

  it("rejects economic values instead of silently accepting them", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/business-commercial-settings", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          action: "reconfirm_target_pack",
          expectedUpdatedAt: "2026-07-01T09:30:00.123456Z",
          targetRoas: 99,
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "unexpected_field",
      fields: ["targetRoas"],
    });
    expect(commercialTruth.reconfirmBusinessTargetPack).not.toHaveBeenCalled();
  });

  it("authorizes before returning reconfirmation payload-shape feedback", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValueOnce({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });

    const response = await POST(
      new NextRequest("http://localhost/api/business-commercial-settings", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          action: "not_a_real_action",
          expectedUpdatedAt: "not-a-timestamp",
          targetRoas: 99,
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    expect(commercialTruth.reconfirmBusinessTargetPack).not.toHaveBeenCalled();
  });

  it.each([
    {
      result: { status: "missing", reason: "target_pack_missing" },
      status: 404,
      error: "target_pack_missing",
    },
    {
      result: {
        status: "conflict",
        reason: "target_pack_changed",
        currentUpdatedAt: "2026-07-14T12:00:00.000000Z",
      },
      status: 409,
      error: "target_pack_changed",
    },
    {
      result: {
        status: "invalid_target_pack",
        reason: "target_roas_below_break_even_roas",
        currentUpdatedAt: "2026-07-14T12:00:00.000000Z",
      },
      status: 422,
      error: "invalid_target_pack",
    },
  ])(
    "returns $status for $error without refreshing recommendations",
    async ({ result, status, error }) => {
      vi.mocked(
        commercialTruth.reconfirmBusinessTargetPack,
      ).mockResolvedValueOnce(result as never);

      const response = await POST(
        new NextRequest("http://localhost/api/business-commercial-settings", {
          method: "POST",
          body: JSON.stringify({
            businessId: "biz",
            action: "reconfirm_target_pack",
            expectedUpdatedAt: "2026-07-01T09:30:00.123456Z",
          }),
        }),
      );

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error });
      expect(
        snapshotRefresh.requestMetaSnapshotRefreshForBusiness,
      ).not.toHaveBeenCalled();
      expect(
        commercialTruth.getBusinessCommercialTruthSnapshot,
      ).not.toHaveBeenCalled();
    },
  );

  it("keeps the seeded reviewer read-only for reconfirmation", async () => {
    vi.mocked(demoBusiness.isDemoBusinessId).mockReturnValue(true);
    vi.mocked(reviewerAccess.isReviewerEmail).mockReturnValue(true);

    const response = await POST(
      new NextRequest("http://localhost/api/business-commercial-settings", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          action: "reconfirm_target_pack",
          expectedUpdatedAt: "2026-07-01T09:30:00.123456Z",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(commercialTruth.reconfirmBusinessTargetPack).not.toHaveBeenCalled();
  });
});
