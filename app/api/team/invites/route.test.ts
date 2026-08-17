import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireBusinessAccess: vi.fn(),
  createInvite: vi.fn(),
  listInvitesByBusiness: vi.fn(),
  resendInvite: vi.fn(),
  revokeInvite: vi.fn(),
}));

vi.mock("@/lib/access", () => ({ requireBusinessAccess: mocks.requireBusinessAccess }));
vi.mock("@/lib/account-store", () => ({
  createInvite: mocks.createInvite,
  listInvitesByBusiness: mocks.listInvitesByBusiness,
  resendInvite: mocks.resendInvite,
  revokeInvite: mocks.revokeInvite,
}));
vi.mock("@/lib/request-language", () => ({
  resolveRequestLanguage: () => Promise.resolve("en"),
}));

import { PATCH } from "@/app/api/team/invites/route";

function patch(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/team/invites", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/team/invites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireBusinessAccess.mockResolvedValue({
      membership: { role: "admin" },
      session: { user: { id: "user_1" } },
    });
  });

  it("resends a pending invite behind the same admin gate as issuing one", async () => {
    mocks.resendInvite.mockResolvedValue({
      id: "inv_1",
      token: "fresh-token",
      expires_at: "2026-08-24T09:00:00.000Z",
    });

    const response = await PATCH(
      patch({ businessId: "biz_1", inviteId: "inv_1", action: "resend" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      invite: { id: "inv_1", expiresAt: "2026-08-24T09:00:00.000Z" },
      inviteUrl: "http://localhost/invite/fresh-token",
    });
    expect(mocks.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ minRole: "admin" }),
    );
    expect(mocks.resendInvite).toHaveBeenCalledWith({
      inviteId: "inv_1",
      businessId: "biz_1",
    });
  });

  it("refuses to resend an invite that is not pending", async () => {
    mocks.resendInvite.mockResolvedValue(null);

    const response = await PATCH(
      patch({ businessId: "biz_1", inviteId: "inv_1", action: "resend" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "invite_not_pending" });
  });

  it("still revokes through the same route", async () => {
    const response = await PATCH(
      patch({ businessId: "biz_1", inviteId: "inv_1", action: "revoke" }),
    );
    expect(response.status).toBe(200);
    expect(mocks.revokeInvite).toHaveBeenCalledWith({
      inviteId: "inv_1",
      businessId: "biz_1",
    });
    expect(mocks.resendInvite).not.toHaveBeenCalled();
  });

  it("rejects a payload without an invite or an action", async () => {
    const response = await PATCH(patch({ businessId: "biz_1" }));
    expect(response.status).toBe(400);
    expect(mocks.requireBusinessAccess).not.toHaveBeenCalled();
  });
});
