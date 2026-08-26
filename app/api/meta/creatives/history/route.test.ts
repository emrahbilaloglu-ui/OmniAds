import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/meta/creatives/history/route";

/*
 * The tri-state posture read, at its one database read.
 *
 * The route no longer asks `isDemoBusiness`, which manufactured "live" from a
 * database it could not read. It asks `readMetaBusinessDataPosture`, which
 * reads `businesses.is_demo_business` through this module and answers
 * `unverified` when it cannot — and `getDb()` throws under vitest, so without
 * this the route would correctly refuse every case in this file.
 */
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(async () => "live"),
}));
vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/demo-business", () => ({
  getDemoMetaCreatives: vi.fn(() => ({ status: "ok", rows: [] })),
}));

vi.mock("@/lib/meta/creatives-api", () => ({
  getMetaCreativesApiPayload: vi.fn(),
}));

const demoAuthority = await import("@/app/api/launchpad/meta/demo-write-authority");
const businessMode = await import("@/lib/business-mode.server");
const access = await import("@/lib/access");
const creativesApi = await import("@/lib/meta/creatives-api");

describe("GET /api/meta/creatives/history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue("live");
  });

  it("serves warehouse-backed archive rows without triggering the live surface path", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [],
      snapshot_source: "snapshot",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/creatives/history?businessId=biz&start=2026-03-01&end=2026-03-31&groupBy=creative"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("ok");
    expect(creativesApi.getMetaCreativesApiPayload).toHaveBeenCalledWith({
      request: expect.any(NextRequest),
      requestStartedAt: expect.any(Number),
      businessId: "biz",
      mediaMode: "metadata",
      groupBy: "creative",
      format: "all",
      sort: "roas",
      start: "2026-03-01",
      end: "2026-03-31",
      debugPreview: false,
      debugThumbnail: false,
      debugPerf: false,
      snapshotBypass: false,
      snapshotWarm: false,
      enableCopyRecovery: false,
      enableCreativeBasicsFallback: false,
      enableCreativeDetails: false,
      enableThumbnailBackfill: false,
      enableCardThumbnailBackfill: false,
      enableImageHashLookup: false,
      enableMediaRecovery: false,
      enableMediaCache: true,
      enableDeepAudit: false,
      perAccountSampleLimit: 10,
    });
  });
});
