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

vi.mock("@/lib/meta/snapshot-refresh", () => ({
  requestMetaSnapshotRefreshForBusiness: vi.fn(),
}));

/*
 * The fail-closed demo authority's DB read, stubbed.
 *
 * The GUARD is the code under test — its statuses, its codes and its position
 * in the precedence — so only the read it delegates to is replaced. `getDb()`
 * throws with no DATABASE_URL under vitest, which is why the read has to be
 * mocked rather than the guard.
 */
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(async () => "live"),
}));

const access = await import("@/lib/access");
const labels = await import("@/lib/meta/campaign-labels");
const snapshotRefresh = await import("@/lib/meta/snapshot-refresh");
const { GET, PUT } = await import("@/app/api/meta/campaign-labels/route");
const demoAuthority = await import("@/app/api/launchpad/meta/demo-write-authority");

describe("/api/meta/campaign-labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue("live");
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
    vi.mocked(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).mockResolvedValue({
      ok: true,
      status: "ran",
      businessId: "biz_1",
      snapshotDate: "2026-05-16",
      reason: "campaign_labels_updated",
      cooldownUntil: "2026-05-16T00:05:00.000Z",
      message: "Meta recommendation snapshot refreshed.",
    });
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
    expect(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).toHaveBeenCalledWith({
      businessId: "biz_1",
      reason: "campaign_labels_updated",
    });
    expect(payload.decisionSnapshotRefresh.status).toBe("ran");
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

  it("rejects reviewer read-only label writes before persistence or refresh", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "reviewer_1", email: "shopify-review@adsecute.com" } } as never,
      membership: { businessId: "biz_1" } as never,
    });

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
            },
          ],
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("reviewer_read_only");
    expect(payload.error.action).toBe("campaign_labels_update");
    expect(labels.writeMetaCampaignLabels).not.toHaveBeenCalled();
    expect(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).not.toHaveBeenCalled();
  });

  /*
   * LAW: a demo workspace has zero Meta write authority. Main/Test/Mixed labels
   * are not cosmetic — INVARIANTS makes them a precondition for hard-action
   * semantics — and this route then runs the recommendation engine inline. The
   * refusal must therefore land above BOTH, and this asserts both.
   */
  for (const [authority, status, code] of [
    ["demo", 403, "demo_business_read_only"],
    ["unverified", 503, "demo_status_unverified"],
    ["not_established", 503, "demo_status_unverified"],
  ] as const) {
    it(`refuses ${authority} with no label write and no snapshot work`, async () => {
      vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue(authority);

      const response = await PUT(
        new NextRequest("http://localhost/api/meta/campaign-labels", {
          method: "PUT",
          body: JSON.stringify({
            businessId: "biz_1",
            labels: [{ campaignId: "cmp_2", kind: "test" }],
          }),
        }),
      );

      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
      expect(labels.writeMetaCampaignLabels).not.toHaveBeenCalled();
      expect(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).not.toHaveBeenCalled();
    });
  }

  it("reads the demo flag for the SERVER's business, not the body's", async () => {
    await PUT(
      new NextRequest("http://localhost/api/meta/campaign-labels", {
        method: "PUT",
        body: JSON.stringify({
          businessId: "biz_claimed",
          labels: [{ campaignId: "cmp_2", kind: "test" }],
        }),
      }),
    );

    expect(demoAuthority.readLaunchpadWriteAuthority).toHaveBeenCalledWith("biz_1");
  });

});
