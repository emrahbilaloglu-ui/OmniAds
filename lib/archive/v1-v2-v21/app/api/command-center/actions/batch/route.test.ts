import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/command-center-config", () => ({
  isCommandCenterV1EnabledForBusiness: vi.fn(),
}));

vi.mock("@/lib/command-center-service", () => ({
  getCommandCenterSnapshot: vi.fn(),
}));

vi.mock("@/lib/command-center-store", () => ({
  applyCommandCenterActionMutation: vi.fn(),
  getCommandCenterPermissions: vi.fn(),
}));

const access = await import("@/lib/access");
const config = await import("@/lib/command-center-config");
const service = await import("@/lib/command-center-service");
const store = await import("@/lib/command-center-store");
const { POST } = await import("@/app/api/command-center/actions/batch/route");

const actionFixture = {
  actionFingerprint: "cc_123",
  title: "Promo Hook A",
  sourceSystem: "creative",
  sourceType: "creative_primary_decision",
  queueSection: "default_queue",
  workloadClass: "creative_refresh",
  batchReviewClass: "creative_refresh",
  batchReviewEligible: true,
} as const;

describe("POST /api/command-center/actions/batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {
        user: {
          id: "user_1",
          name: "Operator",
          email: "operator@adsecute.com",
        },
      } as never,
      membership: {
        role: "collaborator",
      } as never,
    });
    vi.mocked(config.isCommandCenterV1EnabledForBusiness).mockReturnValue(true);
    vi.mocked(store.getCommandCenterPermissions).mockReturnValue({
      canEdit: true,
      reason: null,
      role: "collaborator",
    });
    vi.mocked(service.getCommandCenterSnapshot).mockResolvedValue({
      actions: [
        actionFixture,
        {
          ...actionFixture,
          actionFingerprint: "cc_456",
          title: "Promo Hook B",
        },
      ],
    } as never);
    vi.mocked(store.applyCommandCenterActionMutation)
      .mockResolvedValueOnce({
        actionFingerprint: "cc_123",
        workflowStatus: "approved",
      } as never)
      .mockRejectedValueOnce(new Error("transition_failed"));
  });

  it("applies status-only batch mutations and reports partial failures", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/command-center/actions/batch", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          startDate: "2026-04-01",
          endDate: "2026-04-10",
          actionFingerprints: ["cc_123", "cc_456"],
          clientMutationId: "batch_1",
          mutation: "approve",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(false);
    expect(payload.requestedCount).toBe(2);
    expect(payload.successCount).toBe(1);
    expect(payload.failureCount).toBe(1);
    expect(store.applyCommandCenterActionMutation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        clientMutationId: "batch_1:approve:cc_123",
        mutation: "approve",
      }),
    );
    expect(store.applyCommandCenterActionMutation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        clientMutationId: "batch_1:approve:cc_456",
        mutation: "approve",
      }),
    );
  });

  it("rejects unsupported payloads before touching the store", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/command-center/actions/batch", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          actionFingerprints: [],
          clientMutationId: "batch_2",
          mutation: "assign",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("invalid_payload");
    expect(store.applyCommandCenterActionMutation).not.toHaveBeenCalled();
  });
});
