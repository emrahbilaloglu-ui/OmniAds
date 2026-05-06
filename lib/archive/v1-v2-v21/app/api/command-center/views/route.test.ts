import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/command-center-config", () => ({
  isCommandCenterV1EnabledForBusiness: vi.fn(),
}));

vi.mock("@/lib/command-center-store", () => ({
  createCommandCenterSavedView: vi.fn(),
  deleteCommandCenterSavedView: vi.fn(),
  getCommandCenterPermissions: vi.fn(),
  listCommandCenterSavedViews: vi.fn(),
  updateCommandCenterSavedView: vi.fn(),
}));

const access = await import("@/lib/access");
const config = await import("@/lib/command-center-config");
const store = await import("@/lib/command-center-store");
const { GET, POST, PATCH, DELETE } = await import("@/app/api/command-center/views/route");

describe("/api/command-center/views", () => {
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
    vi.mocked(store.listCommandCenterSavedViews).mockResolvedValue([
      {
        id: "builtin:today_priorities",
        businessId: "biz",
        viewKey: "today_priorities",
        name: "Today priorities",
        definition: { watchlistOnly: false },
        isBuiltIn: true,
        createdAt: null,
        updatedAt: null,
      },
    ] as never);
    vi.mocked(store.createCommandCenterSavedView).mockResolvedValue({
      id: "view_1",
      businessId: "biz",
      viewKey: "custom_scale",
      name: "Scale only",
      definition: { tags: ["scale_promotions"] },
      isBuiltIn: false,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    } as never);
    vi.mocked(store.updateCommandCenterSavedView).mockResolvedValue({
      id: "view_1",
      businessId: "biz",
      viewKey: "custom_scale",
      name: "Scale only updated",
      definition: { tags: ["scale_promotions"] },
      isBuiltIn: false,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:05:00.000Z",
    } as never);
  });

  it("lists saved views", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/command-center/views?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.views).toHaveLength(1);
  });

  it("creates a shared saved view", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/command-center/views", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          name: "Scale only",
          definition: { tags: ["scale_promotions"] },
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.view.viewKey).toBe("custom_scale");
  });

  it("updates and deletes custom views", async () => {
    const patchResponse = await PATCH(
      new NextRequest("http://localhost/api/command-center/views", {
        method: "PATCH",
        body: JSON.stringify({
          businessId: "biz",
          viewKey: "custom_scale",
          name: "Scale only updated",
          definition: { tags: ["scale_promotions"] },
        }),
      }),
    );
    expect(patchResponse.status).toBe(200);

    const deleteResponse = await DELETE(
      new NextRequest("http://localhost/api/command-center/views", {
        method: "DELETE",
        body: JSON.stringify({
          businessId: "biz",
          viewKey: "custom_scale",
        }),
      }),
    );
    expect(deleteResponse.status).toBe(200);
    expect(store.deleteCommandCenterSavedView).toHaveBeenCalledWith({
      businessId: "biz",
      viewKey: "custom_scale",
    });
  });
});
