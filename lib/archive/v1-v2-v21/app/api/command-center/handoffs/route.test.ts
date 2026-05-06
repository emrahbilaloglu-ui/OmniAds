import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/command-center-config", () => ({
  isCommandCenterV1EnabledForBusiness: vi.fn(),
}));

vi.mock("@/lib/command-center-store", () => ({
  acknowledgeCommandCenterHandoff: vi.fn(),
  createCommandCenterHandoff: vi.fn(),
  getCommandCenterPermissions: vi.fn(),
  listCommandCenterHandoffs: vi.fn(),
  updateCommandCenterHandoff: vi.fn(),
}));

const access = await import("@/lib/access");
const config = await import("@/lib/command-center-config");
const store = await import("@/lib/command-center-store");
const { GET, POST, PATCH } = await import("@/app/api/command-center/handoffs/route");

describe("/api/command-center/handoffs", () => {
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
    vi.mocked(config.isCommandCenterV1EnabledForBusiness).mockReturnValue(true);
    vi.mocked(store.getCommandCenterPermissions).mockReturnValue({
      canEdit: true,
      reason: null,
      role: "collaborator",
    });
    vi.mocked(store.listCommandCenterHandoffs).mockResolvedValue([
      {
        id: "handoff_1",
        businessId: "biz",
        shift: "morning",
        summary: "Watch promo spend.",
        blockers: ["Awaiting QA"],
        watchouts: ["Promo pace"],
        linkedActionFingerprints: ["cc_1"],
        fromUserId: "user_1",
        fromUserName: "Operator",
        toUserId: "user_2",
        toUserName: "Closer",
        acknowledgedAt: null,
        acknowledgedByUserId: null,
        acknowledgedByUserName: null,
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ] as never);
    vi.mocked(store.createCommandCenterHandoff).mockResolvedValue({
      id: "handoff_1",
    } as never);
    vi.mocked(store.acknowledgeCommandCenterHandoff).mockResolvedValue({
      id: "handoff_1",
      acknowledgedAt: "2026-04-11T01:00:00.000Z",
    } as never);
  });

  it("lists handoffs", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/command-center/handoffs?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.handoffs).toHaveLength(1);
  });

  it("creates a handoff note", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/command-center/handoffs", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          shift: "morning",
          summary: "Watch promo spend.",
          blockers: ["Awaiting QA"],
          watchouts: ["Promo pace"],
          linkedActionFingerprints: ["cc_1"],
          toUserId: "user_2",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(store.createCommandCenterHandoff).toHaveBeenCalled();
  });

  it("acknowledges a handoff", async () => {
    const response = await PATCH(
      new NextRequest("http://localhost/api/command-center/handoffs", {
        method: "PATCH",
        body: JSON.stringify({
          businessId: "biz",
          handoffId: "handoff_1",
          action: "acknowledge",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(store.acknowledgeCommandCenterHandoff).toHaveBeenCalledWith({
      businessId: "biz",
      handoffId: "handoff_1",
      userId: "user_1",
    });
  });
});
