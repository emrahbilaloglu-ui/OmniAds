import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: mocks.query }),
}));

import {
  readCampaignContextCampaignMeta,
  readCampaignContextCreativeDays,
} from "../campaign-context/data";

describe("campaign context warehouse account scope", () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it("computes first-spend lineage separately inside each provider account", async () => {
    mocks.query.mockResolvedValue([
      {
        provider_account_id: "act_1",
        campaign_id: "cmp_1",
        adset_id: "adset_1",
        creative_id: "creative_1",
        date: "2026-08-28",
        spend: 12,
        first_spend_date: "2026-08-01",
      },
    ]);

    const rows = await readCampaignContextCreativeDays(
      "biz_1",
      "2026-08-01",
      "2026-08-28",
    );
    const [sql, params] = mocks.query.mock.calls[0] ?? [];

    expect(sql).toContain(
      "GROUP BY provider_account_id, creative_id",
    );
    expect(sql).toContain(
      "fs.provider_account_id = d.provider_account_id",
    );
    expect(params).toEqual(["biz_1", "2026-08-01", "2026-08-28"]);
    expect(rows[0]?.providerAccountId).toBe("act_1");
  });

  it("reads campaign names and first-seen dates inside one exact provider account", async () => {
    mocks.query.mockResolvedValue([
      {
        provider_account_id: "act_2",
        campaign_id: "cmp_2",
        campaign_name: "Main evergreen",
        first_seen_date: "2026-07-01",
      },
    ]);

    const rows = await readCampaignContextCampaignMeta(
      "biz_1",
      "2026-08-28",
      "act_2",
    );
    const [sql, params] = mocks.query.mock.calls[0] ?? [];

    expect(sql).toContain(
      "SELECT DISTINCT ON (provider_account_id, campaign_id)",
    );
    expect(sql).toContain("provider_account_id = $3");
    expect(params).toEqual(["biz_1", "2026-08-28", "act_2"]);
    expect(rows.get("cmp_2")).toMatchObject({
      providerAccountId: "act_2",
      campaignName: "Main evergreen",
      firstSeenDate: "2026-07-01",
    });
  });
});
