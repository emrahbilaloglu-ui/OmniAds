import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/command-center-config", () => ({
  isCommandCenterV1EnabledForBusiness: vi.fn(),
}));

vi.mock("@/lib/command-center-service", () => ({
  findCommandCenterActionForRange: vi.fn(),
}));

vi.mock("@/lib/command-center-store", () => ({
  createCommandCenterFeedback: vi.fn(),
  getCommandCenterPermissions: vi.fn(),
}));

const access = await import("@/lib/access");
const config = await import("@/lib/command-center-config");
const service = await import("@/lib/command-center-service");
const store = await import("@/lib/command-center-store");
const { POST } = await import("@/app/api/command-center/feedback/route");

describe("POST /api/command-center/feedback", () => {
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
    vi.mocked(service.findCommandCenterActionForRange).mockResolvedValue({
      actionFingerprint: "cc_123",
      title: "Promo Hook A",
      sourceSystem: "creative",
      sourceType: "creative_primary_decision",
    } as never);
    vi.mocked(store.createCommandCenterFeedback).mockResolvedValue({
      id: "feedback_1",
      businessId: "biz",
      clientMutationId: "feedback_mutation_1",
      feedbackType: "false_positive",
      scope: "action",
      actionFingerprint: "cc_123",
      actionTitle: "Promo Hook A",
      sourceSystem: "creative",
      sourceType: "creative_primary_decision",
      viewKey: null,
      actorUserId: "user_1",
      actorName: "Operator",
      actorEmail: "operator@adsecute.com",
      note: "This should stay in test.",
      createdAt: "2026-04-11T00:00:00.000Z",
    } as never);
  });

  it("creates action-scoped feedback for a surfaced action", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/command-center/feedback", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          startDate: "2026-04-01",
          endDate: "2026-04-10",
          actionFingerprint: "cc_123",
          clientMutationId: "feedback_mutation_1",
          feedbackType: "false_positive",
          scope: "action",
          note: "This should stay in test.",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(store.createCommandCenterFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        actionFingerprint: "cc_123",
        feedbackType: "false_positive",
        scope: "action",
      }),
    );
  });

  it("creates queue-gap false-negative feedback without an action fingerprint", async () => {
    vi.mocked(store.createCommandCenterFeedback).mockResolvedValue({
      id: "feedback_2",
      businessId: "biz",
      clientMutationId: "feedback_mutation_2",
      feedbackType: "false_negative",
      scope: "queue_gap",
      actionFingerprint: null,
      actionTitle: null,
      sourceSystem: "meta",
      sourceType: null,
      viewKey: "today_priorities",
      actorUserId: "user_1",
      actorName: "Operator",
      actorEmail: "operator@adsecute.com",
      note: "A donor campaign reallocation is missing.",
      createdAt: "2026-04-11T00:00:00.000Z",
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/command-center/feedback", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          clientMutationId: "feedback_mutation_2",
          feedbackType: "false_negative",
          scope: "queue_gap",
          sourceSystem: "meta",
          viewKey: "today_priorities",
          note: "A donor campaign reallocation is missing.",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.feedback.scope).toBe("queue_gap");
    expect(store.createCommandCenterFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        feedbackType: "false_negative",
        scope: "queue_gap",
        sourceSystem: "meta",
        viewKey: "today_priorities",
      }),
    );
  });

  it("rejects false-negative feedback when it is incorrectly action-scoped", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/command-center/feedback", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          startDate: "2026-04-01",
          endDate: "2026-04-10",
          actionFingerprint: "cc_123",
          clientMutationId: "feedback_mutation_3",
          feedbackType: "false_negative",
          scope: "action",
          note: "This action should never exist.",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("invalid_feedback_scope");
    expect(store.createCommandCenterFeedback).not.toHaveBeenCalled();
  });
});
