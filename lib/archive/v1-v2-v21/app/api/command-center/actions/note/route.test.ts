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
  addCommandCenterNote: vi.fn(),
  getCommandCenterPermissions: vi.fn(),
}));

const access = await import("@/lib/access");
const config = await import("@/lib/command-center-config");
const service = await import("@/lib/command-center-service");
const store = await import("@/lib/command-center-store");
const { POST } = await import("@/app/api/command-center/actions/note/route");

describe("POST /api/command-center/actions/note", () => {
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
    vi.mocked(store.addCommandCenterNote).mockResolvedValue({
      actionFingerprint: "cc_123",
      noteCount: 1,
      latestNoteExcerpt: "Take this live after QA.",
    } as never);
  });

  it("adds a note to an existing action", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/command-center/actions/note", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          actionFingerprint: "cc_123",
          clientMutationId: "note_1",
          note: "Take this live after QA.",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(store.addCommandCenterNote).toHaveBeenCalled();
  });
});
