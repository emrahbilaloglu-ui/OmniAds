import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/meta/creatives-fetchers", () => ({ fetchAssignedAccountIds: vi.fn() }));
vi.mock("@/lib/meta/ad-funnel-evidence", () => ({
  META_AD_FUNNEL_EVIDENCE_CONTRACT_VERSION: "meta-ad-funnel-evidence.v1",
  readMetaAdFunnelEvidenceWindow: vi.fn(),
}));

const access = await import("@/lib/access");
const fetchers = await import("@/lib/meta/creatives-fetchers");
const evidence = await import("@/lib/meta/ad-funnel-evidence");
const BASE = "businessId=biz_1&providerAccountId=act_1&adId=ad_1&start=2026-09-16&end=2026-09-22";
const request = (query: string) => new NextRequest(`http://localhost/api/meta/ads/funnel?${query}`);

describe("GET /api/meta/ads/funnel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never, membership: {} as never,
    });
    vi.mocked(fetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
    vi.mocked(evidence.readMetaAdFunnelEvidenceWindow).mockResolvedValue({
      rows: [], coverageComplete: true,
    });
  });

  it("requires a bounded exact Ad and calendar range", async () => {
    const invalid = await GET(request("businessId=biz_1&adId=ad_1"));
    expect(invalid.status).toBe(400);
    const impossibleDay = await GET(request(BASE.replace("2026-09-22", "2026-09-31")));
    expect(impossibleDay.status).toBe(400);
    expect(evidence.readMetaAdFunnelEvidenceWindow).not.toHaveBeenCalled();
  });

  it("honors business access and assigned Meta account before reading facts", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValueOnce({
      error: new Response("denied", { status: 403 }),
    } as never);
    expect((await GET(request(BASE))).status).toBe(403);
    vi.mocked(fetchers.fetchAssignedAccountIds).mockResolvedValueOnce(["act_2"]);
    expect((await GET(request(BASE))).status).toBe(403);
    expect(evidence.readMetaAdFunnelEvidenceWindow).not.toHaveBeenCalled();
  });

  it("queries only the requested assigned Ad and rejects an incomplete window", async () => {
    vi.mocked(evidence.readMetaAdFunnelEvidenceWindow).mockResolvedValueOnce({
      rows: [], coverageComplete: false,
    });
    const incomplete = await GET(request(BASE));
    expect(incomplete.status).toBe(409);
    expect(evidence.readMetaAdFunnelEvidenceWindow).toHaveBeenCalledWith({
      businessId: "biz_1", providerAccountId: "act_1", adId: "ad_1",
      start: "2026-09-16", end: "2026-09-22",
    });
    const complete = await GET(request(BASE));
    expect(complete.status).toBe(200);
    await expect(complete.json()).resolves.toEqual({
      status: "ok", contractVersion: "meta-ad-funnel-evidence.v1",
      rows: [], coverageComplete: true,
    });
  });
});
