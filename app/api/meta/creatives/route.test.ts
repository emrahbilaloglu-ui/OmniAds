import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/meta/creatives/route";

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/demo-business", () => ({
  getDemoMetaCreatives: vi.fn(() => ({
    status: "ok",
    rows: [
      { id: "demo-1", creative_id: "cr_shared", account_id: "act_demo_1" },
      { id: "demo-2", creative_id: "cr_shared", account_id: "act_demo_2" },
      { id: "demo-3", creative_id: "cr_other", account_id: "act_demo_2" },
    ],
  })),
  getDemoProviderAccounts: vi.fn(() => [
    { id: "act_demo_1" },
    { id: "act_demo_2" },
  ]),
}));

vi.mock("@/lib/meta/creatives-api", () => ({
  getMetaCreativesApiPayload: vi.fn(),
}));

vi.mock("@/lib/perf", () => ({
  logPerfEvent: vi.fn(),
}));

const businessMode = await import("@/lib/business-mode.server");
const access = await import("@/lib/access");
const demoBusiness = await import("@/lib/demo-business");
const creativesApi = await import("@/lib/meta/creatives-api");
const perf = await import("@/lib/perf");

describe("GET /api/meta/creatives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
  });

  it("uses snapshot-first creatives payload for the main surface", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/creatives?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=creative&mediaMode=full"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.snapshot_source).toBe("persisted");
    expect(creativesApi.getMetaCreativesApiPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        providerAccountId: "act_1",
        start: "2026-03-01",
        end: "2026-03-31",
        groupBy: "creative",
        mediaMode: "full",
        snapshotBypass: false,
        snapshotWarm: false,
      })
    );
    expect(perf.logPerfEvent).toHaveBeenCalledWith(
      "meta_creatives_route",
      expect.objectContaining({
        businessId: "biz",
        providerAccountId: "act_1",
        dateSpanDays: 31,
        rowCount: 0,
        readSource: "persisted",
        freshnessState: null,
      })
    );
  });

  it("rejects deprecated detail preview requests on the main route", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/creatives?businessId=biz&detailPreviewCreativeId=cr_1"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("detail_preview_moved");
    expect(creativesApi.getMetaCreativesApiPayload).not.toHaveBeenCalled();
  });

  it("forwards a normalized creative usage filter and records it in perf metadata", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [],
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/creatives?businessId=biz&providerAccountId=act_1&groupBy=ad&creativeId=%20cr_42%20",
      ),
    );

    expect(response.status).toBe(200);
    expect(creativesApi.getMetaCreativesApiPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountId: "act_1",
        creativeId: "cr_42",
        groupBy: "ad",
      }),
    );
    expect(perf.logPerfEvent).toHaveBeenCalledWith(
      "meta_creatives_route",
      expect.objectContaining({
        providerAccountId: "act_1",
        creativeId: "cr_42",
        groupBy: "ad",
      }),
    );
  });

  it("keeps safe thumbnail backfills enabled in metadata mode while leaving risky enrichment full-only", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [],
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/creatives?businessId=biz&providerAccountId=act_1&mediaMode=metadata"
      )
    );

    expect(response.status).toBe(200);
    expect(creativesApi.getMetaCreativesApiPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaMode: "metadata",
        providerAccountId: "act_1",
        enableThumbnailBackfill: true,
        enableCardThumbnailBackfill: true,
        enableCreativeDetails: false,
        enableImageHashLookup: false,
        enableMediaRecovery: false,
      })
    );
  });

  it("returns 400 when the scoped reader requires an account selection", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "provider_account_required",
      rows: [],
      providerAccountId: null,
    } as never);

    const response = await GET(
      new NextRequest("http://localhost/api/meta/creatives?businessId=biz"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      status: "provider_account_required",
      rows: [],
    });
  });

  it("returns 403 when the requested account is not assigned", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "account_not_assigned",
      rows: [],
      providerAccountId: "act_other",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/creatives?businessId=biz&providerAccountId=act_other",
      ),
    );

    expect(response.status).toBe(403);
  });

  it("requires explicit account scope for a multi-account demo business", async () => {
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(true);

    const response = await GET(
      new NextRequest("http://localhost/api/meta/creatives?businessId=demo"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      status: "provider_account_required",
      rows: [],
    });
    expect(creativesApi.getMetaCreativesApiPayload).not.toHaveBeenCalled();
  });

  it("filters demo rows to the requested account and exact creative", async () => {
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(true);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/creatives?businessId=demo&providerAccountId=act_demo_2&groupBy=ad&creativeId=cr_shared",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(demoBusiness.getDemoProviderAccounts).toHaveBeenCalledWith("meta");
    expect(payload).toMatchObject({
      providerAccountId: "act_demo_2",
      account_scope: { status: "resolved", resolution: "explicit" },
    });
    expect(payload.rows).toEqual([
      { id: "demo-2", creative_id: "cr_shared", account_id: "act_demo_2" },
    ]);
  });

  it("rejects an unassigned demo account", async () => {
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(true);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/creatives?businessId=demo&providerAccountId=act_other",
      ),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      status: "account_not_assigned",
      rows: [],
    });
  });
});
