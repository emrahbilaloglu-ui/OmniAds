import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readMetaCampaignLabels,
  readMetaCampaignLabelsAsOf,
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

function createSqlMock(
  rowsOrResolver:
    unknown[] | ((query: string) => unknown[] | Promise<unknown[]>) = [],
) {
  const queries: string[] = [];
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = joinTemplate(strings, values);
      queries.push(query);
      return typeof rowsOrResolver === "function"
        ? rowsOrResolver(query)
        : rowsOrResolver;
    }),
    {
      query: vi.fn(),
      queries,
    },
  );
  return sql;
}

// D074: the manual write implementation is removed from the product. Only the
// read-only historical comparator surface remains, and only it is tested.
describe("meta campaign labels (frozen read-only comparator)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("reads immutable label state at an account-scoped cutoff", async () => {
    const sql = createSqlMock([
      {
        business_id: "biz_1",
        campaign_id: "cmp_1",
        campaign_kind: "main",
        test_dimension: null,
        source: "user",
        provider_account_id: "act_1",
        campaign_name: "Main",
        labeled_by: "user_1",
        labeled_at: "2026-07-10T03:00:00.000Z",
        updated_at: "2026-07-10T03:00:00.000Z",
        change_kind: "updated",
        observed_at: "2026-07-10T03:00:00.000Z",
        state_hash: "a".repeat(64),
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await readMetaCampaignLabelsAsOf({
      businessId: "biz_1",
      providerAccountId: "act_1",
      campaignIds: ["cmp_1", "cmp_1"],
      cutoff: "2026-07-10T04:00:00Z",
    });

    expect(rows[0]).toMatchObject({
      businessId: "biz_1",
      providerAccountId: "act_1",
      campaignId: "cmp_1",
      changeKind: "updated",
      observedAt: "2026-07-10T03:00:00.000Z",
    });
    const query = sql.queries.join("\n");
    expect(query).toContain("FROM meta_campaign_label_history");
    expect(query).toContain("business_id = biz_1");
    expect(query).toContain("provider_account_id = act_1");
    expect(query).toContain("observed_at <= 2026-07-10T04:00:00.000Z");
    expect(query).toContain("DISTINCT ON (campaign_id)");
  });

  it("rejects an invalid as-of cutoff before querying", async () => {
    const sql = createSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      readMetaCampaignLabelsAsOf({
        businessId: "biz_1",
        providerAccountId: "act_1",
        cutoff: "not-a-date",
      }),
    ).rejects.toThrow("cutoff must be a valid timestamp");
    expect(sql).not.toHaveBeenCalled();
  });
});
