import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/snapshot-refresh", () => ({
  requestMetaSnapshotRefreshForBusiness: vi.fn(),
}));

/*
 * The demo authority's DB read, stubbed. The guard itself is the code under
 * test; `getDb()` throws with no DATABASE_URL under vitest, so the read is
 * what has to be replaced.
 */
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(),
}));

const access = await import("@/lib/access");
const snapshotRefresh = await import("@/lib/meta/snapshot-refresh");
const demoAuthority = await import("@/app/api/launchpad/meta/demo-write-authority");
const { POST } = await import("@/app/api/meta/snapshot/run-now/route");

describe("POST /api/meta/snapshot/run-now", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } } as never,
      membership: { businessId: "biz_1" } as never,
    });
    vi.mocked(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).mockResolvedValue({
      ok: true,
      status: "ran",
      businessId: "biz_1",
      snapshotDate: "2026-05-16",
      reason: "manual",
      cooldownUntil: "2026-05-16T00:05:00.000Z",
      message: "Meta recommendation snapshot refreshed.",
    });
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue("live");
  });

  it("runs a manual snapshot refresh behind collaborator access", async () => {
    const request = new NextRequest("http://localhost/api/meta/snapshot/run-now", {
      method: "POST",
      body: JSON.stringify({ businessId: "biz_1" }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request,
      businessId: "biz_1",
      minRole: "collaborator",
    });
    expect(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).toHaveBeenCalledWith({
      businessId: "biz_1",
      reason: "manual",
    });
    expect(payload.status).toBe("ran");
  });

  it("requires businessId", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/meta/snapshot/run-now", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("missing_business_id");
    expect(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).not.toHaveBeenCalled();
  });

  it("rejects reviewer read-only attempts before running a refresh", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "reviewer_1", email: "shopify-review@adsecute.com" } } as never,
      membership: { businessId: "biz_1" } as never,
    });

    const response = await POST(
      new NextRequest("http://localhost/api/meta/snapshot/run-now", {
        method: "POST",
        body: JSON.stringify({ businessId: "biz_1" }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("reviewer_read_only");
    expect(payload.error.action).toBe("snapshot_refresh");
    expect(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).not.toHaveBeenCalled();
  });

  /*
   * LAW: a demo workspace has zero Meta write authority — and "it reaches no
   * provider" is not the test. This route runs the recommendation engine
   * INLINE: `requestMetaSnapshotRefreshForBusiness` stamps a five-minute
   * in-process cooldown before it does anything else, and what it then runs
   * opens a calibration transaction and upserts snapshot rows. So the refusal
   * has to sit above the call, and "nothing was queued" is proven by the call
   * never being made.
   */
  it("refuses a confirmed demo workspace before the refresh is requested", async () => {
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue("demo");

    const response = await POST(
      new NextRequest("http://localhost/api/meta/snapshot/run-now", {
        method: "POST",
        body: JSON.stringify({ businessId: "biz_1" }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("demo_business_read_only");
    expect(payload.error.action).toBe("snapshot_refresh");
    expect(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).not.toHaveBeenCalled();
  });

  for (const authority of ["unverified", "not_established"] as const) {
    it(`refuses when demo status reads back as ${authority}, and queues nothing`, async () => {
      vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue(authority);

      const response = await POST(
        new NextRequest("http://localhost/api/meta/snapshot/run-now", {
          method: "POST",
          body: JSON.stringify({ businessId: "biz_1" }),
        }),
      );
      const payload = await response.json();

      expect(response.status).toBe(503);
      expect(payload.error.code).toBe("demo_status_unverified");
      expect(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).not.toHaveBeenCalled();
    });
  }

  it("carries the refusal where the shared interpreter can read it", async () => {
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue("demo");

    const payload = await (
      await POST(
        new NextRequest("http://localhost/api/meta/snapshot/run-now", {
          method: "POST",
          body: JSON.stringify({ businessId: "biz_1" }),
        }),
      )
    ).json();

    /*
     * Both mounted clients read this response through
     * `interpretMetaSnapshotRunResponse`, which falls back to the generic
     * "Snapshot refresh failed." when it finds no sentence. The refusal is
     * therefore stated at the top level as well as inside `error`.
     */
    expect(typeof payload.message).toBe("string");
    expect(payload.message).toBe(payload.error.message);
    expect(payload.message).toContain("Demo workspaces have zero Meta write authority");
  });

  it("reads the demo flag for the SERVER's business, not the query string's", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } } as never,
      membership: { businessId: "biz_resolved" } as never,
    });

    await POST(
      new NextRequest("http://localhost/api/meta/snapshot/run-now?businessId=biz_claimed", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );

    expect(demoAuthority.readLaunchpadWriteAuthority).toHaveBeenCalledWith("biz_resolved");
  });
});
