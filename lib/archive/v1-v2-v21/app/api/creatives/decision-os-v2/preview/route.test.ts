import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/creative-decision-os-config", () => ({
  isCreativeDecisionOsV1EnabledForBusiness: vi.fn(),
}));

vi.mock("@/lib/creative-decision-os-snapshots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/creative-decision-os-snapshots")>();
  return {
    ...actual,
    getLatestCreativeDecisionOsSnapshot: vi.fn(),
  };
});

const access = await import("@/lib/access");
const config = await import("@/lib/creative-decision-os-config");
const snapshotStore = await import("@/lib/creative-decision-os-snapshots");
const route = await import("@/app/api/creatives/decision-os-v2/preview/route");
const GET = route.GET as (request: NextRequest) => Promise<Response>;

describe("GET /api/creatives/decision-os-v2/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(config.isCreativeDecisionOsV1EnabledForBusiness).mockReturnValue(true);
    vi.mocked(snapshotStore.getLatestCreativeDecisionOsSnapshot).mockResolvedValue(null);
  });

  it("is off by default and does not read the snapshot payload", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/creatives/decision-os-v2/preview?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.contractVersion).toBe("creative-decision-os-v2-preview.v0.1.1");
    expect(payload.enabled).toBe(false);
    expect(payload.decisionOsV2Preview).toBeNull();
    expect(snapshotStore.getLatestCreativeDecisionOsSnapshot).not.toHaveBeenCalled();
  });

  it("loads the read-only preview only when the preview flag is present", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-os-v2/preview?businessId=biz&creativeDecisionOsV2Preview=1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.enabled).toBe(true);
    expect(payload.decisionOsV2Preview).toBeNull();
    expect(snapshotStore.getLatestCreativeDecisionOsSnapshot).toHaveBeenCalledWith({
      businessId: "biz",
      benchmarkScope: null,
    });
  });
});
