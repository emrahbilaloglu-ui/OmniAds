import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeMetaCampaignLabelInput,
  readMetaCampaignLabels,
  writeMetaCampaignLabels,
} from "@/lib/meta/campaign-labels";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const db = await import("@/lib/db");

function joinTemplate(strings: TemplateStringsArray, values: unknown[]) {
  return strings.reduce((statement, part, index) => {
    const value = index < values.length ? String(values[index]) : "";
    return `${statement}${part}${value}`;
  }, "");
}

function createSqlMock(rows: unknown[] = []) {
  const queries: string[] = [];
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(joinTemplate(strings, values));
      return rows;
    }),
    {
      query: vi.fn(),
      queries,
    },
  );
  return sql;
}

describe("meta campaign labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes non-test labels by clearing testDimension", () => {
    expect(
      normalizeMetaCampaignLabelInput({
        campaignId: " cmp_1 ",
        kind: "main",
        testDimension: "creative",
      }),
    ).toMatchObject({
      campaignId: "cmp_1",
      kind: "main",
      testDimension: null,
      source: "user",
    });
  });

  it("rejects invalid campaign kind", () => {
    expect(() =>
      normalizeMetaCampaignLabelInput({
        campaignId: "cmp_1",
        kind: "scale" as never,
      }),
    ).toThrow("kind must be main, test or mixed");
  });

  it("reads labels scoped by business and campaign ids", async () => {
    const sql = createSqlMock([
      {
        business_id: "biz_1",
        campaign_id: "cmp_1",
        campaign_kind: "test",
        test_dimension: "creative",
        source: "user",
        provider_account_id: "act_1",
        campaign_name: "Test Campaign",
        labeled_by: "user_1",
        labeled_at: "2026-05-15T10:00:00.000Z",
        updated_at: "2026-05-15T10:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await readMetaCampaignLabels({
      businessId: "biz_1",
      campaignIds: ["cmp_1", "cmp_1", ""],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      businessId: "biz_1",
      campaignId: "cmp_1",
      kind: "test",
      testDimension: "creative",
    });
    expect(sql.queries.join("\n")).toContain("campaign_id = ANY");
  });

  it("upserts labels without preserving stale test dimensions for main or mixed", async () => {
    const sql = createSqlMock([
      {
        business_id: "biz_1",
        campaign_id: "cmp_1",
        campaign_kind: "main",
        test_dimension: null,
        source: "user",
        provider_account_id: "act_1",
        campaign_name: "Main Campaign",
        labeled_by: "user_1",
        labeled_at: "2026-05-15T10:00:00.000Z",
        updated_at: "2026-05-15T10:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await writeMetaCampaignLabels({
      businessId: "biz_1",
      labeledBy: "user_1",
      labels: [
        {
          campaignId: "cmp_1",
          kind: "main",
          testDimension: "creative",
          providerAccountId: "act_1",
          campaignName: "Main Campaign",
        },
      ],
    });

    expect(rows[0]).toMatchObject({
      campaignId: "cmp_1",
      kind: "main",
      testDimension: null,
    });
    expect(sql.queries.join("\n")).toContain("ON CONFLICT (business_id, campaign_id)");
  });
});
