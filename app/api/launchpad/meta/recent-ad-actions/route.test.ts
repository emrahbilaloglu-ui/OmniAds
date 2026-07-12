import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-validation", () => ({
  metaLaunchAccountBlockerHttpStatus: vi.fn((code: string) =>
    code === "provider_account_not_assigned" ? 403 : 400,
  ),
  resolveAssignedMetaLaunchAccount: vi.fn(),
}));

const access = await import("@/lib/access");
const db = await import("@/lib/db");
const validation = await import("@/lib/launchpad/meta-validation");
const { GET } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const PROVIDER_ACCOUNT_ID = "act_123";

describe("GET /api/launchpad/meta/recent-ad-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user" } },
      membership: { businessId: BUSINESS_ID },
    } as never);
    vi.mocked(validation.resolveAssignedMetaLaunchAccount).mockResolvedValue({
      ok: true,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    });
  });

  it("returns recent duplicated ad markers with target names from the action log fallback", async () => {
    const sql = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [
      {
        action: "launch_ad",
        requested_at: "2026-05-06T12:00:00.000Z",
        ad_id: "source_ad_1",
        creative_id: null,
        resulting_ad_id: "new_ad_1",
        payload_request: {
          target_campaign_id: "cmp_1",
          target_campaign_name: "Main Campaign",
          target_adset_id: "adset_1",
          target_adset_name: "Main Ad Set",
          body: {
            name: "Creative added",
            source_creative_id: "creative_1",
            status_option: "PAUSED",
          },
        },
        ad_name_current: null,
        ad_name_historical: null,
        ad_status: null,
        dim_creative_id: null,
        source_ad_name_current: "Creative Original",
        source_ad_name_historical: null,
        source_dim_creative_id: "creative_1",
        provider_account_id: "act_123",
        campaign_id: null,
        campaign_name_current: null,
        campaign_name_historical: null,
        adset_id: null,
        adset_name_current: null,
        adset_name_historical: null,
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/recent-ad-actions?businessId=${BUSINESS_ID}&providerAccountId=${PROVIDER_ACCOUNT_ID}`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.providerAccountId).toBe(PROVIDER_ACCOUNT_ID);
    expect(body.actions).toEqual([
      {
        action: "launch_ad",
        requestedAt: "2026-05-06T12:00:00.000Z",
        sourceAdId: "source_ad_1",
        sourceName: "Creative Original",
        resultingAdId: "new_ad_1",
        creativeId: "creative_1",
        adName: "Creative added",
        status: "PAUSED",
        accountId: "act_123",
        targetCampaignId: "cmp_1",
        targetCampaignName: "Main Campaign",
        targetAdsetId: "adset_1",
        targetAdsetName: "Main Ad Set",
      },
    ]);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request: expect.any(NextRequest),
      businessId: BUSINESS_ID,
      minRole: "collaborator",
    });
    const queryParts = sql.mock.calls[0]?.[0] as unknown as string[] | undefined;
    const query = String(queryParts?.join(" ") ?? "");
    expect(query).toContain("meta_launch_intents");
    expect(query).toContain("launch_intent_id");
    expect(query).toContain("source_ad.provider_account_id");
    expect(sql.mock.calls[0]).toContain(PROVIDER_ACCOUNT_ID);
  });

  it("fails closed before reading action logs when the account is not assigned", async () => {
    vi.mocked(validation.resolveAssignedMetaLaunchAccount).mockResolvedValue({
      ok: false,
      blocker: {
        code: "provider_account_not_assigned",
        message: "providerAccountId is not assigned to this business.",
      },
    });
    const sql = vi.fn();
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/recent-ad-actions?businessId=${BUSINESS_ID}&providerAccountId=act_other`,
      ),
    );

    expect(response.status).toBe(403);
    expect(sql).not.toHaveBeenCalled();
  });
});
