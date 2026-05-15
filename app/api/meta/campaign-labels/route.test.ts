import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/campaign-labels", async () => {
  const actual = await vi.importActual<typeof import("@/lib/meta/campaign-labels")>(
    "@/lib/meta/campaign-labels",
  );
  return {
    ...actual,
    readMetaCampaignLabels: vi.fn(),
    writeMetaCampaignLabels: vi.fn(),
  };
});

const access = await import("@/lib/access");
const labels = await import("@/lib/meta/campaign-labels");
const { GET, PUT } = await import("@/app/api/meta/campaign-labels/route");

describe("/api/meta/campaign-labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } } as never,
      membership: { businessId: "biz_1" } as never,
    });
    vi.mocked(labels.readMetaCampaignLabels).mockResolvedValue([
      {
        businessId: "biz_1",
        campaignId: "cmp_1",
        kind: "main",
        testDimension: null,
        source: "user",
        providerAccountId: "act_1",
        campaignName: "Main Campaign",
        labeledBy: "user_1",
        labeledAt: "2026-05-15T10:00:00.000Z",
        updatedAt: "2026-05-15T10:00:00.000Z",
      },
    ]);
    vi.mocked(labels.writeMetaCampaignLabels).mockResolvedValue([
      {
        businessId: "biz_1",
        campaignId: "cmp_2",
        kind: "test",
        testDimension: "creative",
        source: "user",
        providerAccountId: "act_1",
        campaignName: "Creative Test",
        labeledBy: "user_1",
        labeledAt: "2026-05-15T10:00:00.000Z",
        updatedAt: "2026-05-15T10:00:00.000Z",
      },
    ]);
  });

  it("reads campaign labels behind guest business access", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/campaign-labels?businessId=biz_1&campaignIds=cmp_1,cmp_2",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(access.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz_1", minRole: "guest" }),
    );
    expect(labels.readMetaCampaignLabels).toHaveBeenCalledWith({
      businessId: "biz_1",
      campaignIds: ["cmp_1", "cmp_2"],
    });
    expect(payload.labels[0].campaignId).toBe("cmp_1");
  });

  it("writes campaign labels behind collaborator access", async () => {
    const response = await PUT(
      new NextRequest("http://localhost/api/meta/campaign-labels", {
        method: "PUT",
        body: JSON.stringify({
          businessId: "biz_1",
          labels: [
            {
              campaignId: "cmp_2",
              kind: "test",
              testDimension: "creative",
              providerAccountId: "act_1",
              campaignName: "Creative Test",
            },
          ],
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz_1", minRole: "collaborator" }),
    );
    expect(labels.writeMetaCampaignLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
        labeledBy: "user_1",
        labels: [
          expect.objectContaining({
            campaignId: "cmp_2",
            kind: "test",
            testDimension: "creative",
          }),
        ],
      }),
    );
    expect(payload.labels[0].kind).toBe("test");
  });

  it("rejects empty write batches", async () => {
    const response = await PUT(
      new NextRequest("http://localhost/api/meta/campaign-labels", {
        method: "PUT",
        body: JSON.stringify({ businessId: "biz_1", labels: [] }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("invalid_labels");
    expect(labels.writeMetaCampaignLabels).not.toHaveBeenCalled();
  });
});
