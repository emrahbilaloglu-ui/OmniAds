import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeMetaCampaignLabelInput,
  readMetaCampaignLabels,
  readMetaCampaignLabelsAsOf,
  writeMetaCampaignLabels,
} from "@/lib/meta/campaign-labels";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  runDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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

describe("meta campaign labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.runDbTransaction).mockImplementation(
      async (fn: () => Promise<unknown>) => fn(),
    );
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
    const returnedRow = {
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
    };
    const sql = createSqlMock((query) => {
      if (query.includes("FROM businesses business")) {
        return [
          {
            business_ref_id: "biz_1",
            provider_account_ref_id: "account_ref_1",
            provider_account_id: "act_1",
          },
        ];
      }
      return query.includes("INSERT INTO meta_campaign_labels")
        ? [returnedRow]
        : [];
    });
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
    const queries = sql.queries.join("\n");
    expect(db.runDbTransaction).toHaveBeenCalledTimes(1);
    expect(queries).toContain("pg_advisory_xact_lock");
    expect(queries).toContain("ON CONFLICT (business_id, campaign_id)");
    expect(queries).toContain("INSERT INTO meta_campaign_label_history");
    expect(queries).toContain("business_ref_id");
    expect(queries).toContain("provider_account_ref_id");
  });

  it("deduplicates repeated campaign ids before locking and writing", async () => {
    const returnedRow = {
      business_id: "biz_1",
      campaign_id: "cmp_1",
      campaign_kind: "test",
      test_dimension: "audience",
      source: "user",
      provider_account_id: "act_1",
      campaign_name: "Latest",
      labeled_by: "user_1",
      labeled_at: "2026-07-12T10:00:00.000Z",
      updated_at: "2026-07-12T10:00:00.000Z",
    };
    const sql = createSqlMock((query) => {
      if (query.includes("FROM businesses business")) {
        return [
          {
            business_ref_id: "biz_1",
            provider_account_ref_id: "account_ref_1",
            provider_account_id: "act_1",
          },
        ];
      }
      return query.includes("INSERT INTO meta_campaign_labels")
        ? [returnedRow]
        : [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await writeMetaCampaignLabels({
      businessId: "biz_1",
      labeledBy: "user_1",
      labels: [
        { campaignId: "cmp_1", kind: "main", providerAccountId: "act_1" },
        {
          campaignId: "cmp_1",
          kind: "test",
          testDimension: "audience",
          providerAccountId: "act_1",
          campaignName: "Latest",
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "test", testDimension: "audience" });
    expect(
      sql.queries.filter((query) =>
        query.includes("INSERT INTO meta_campaign_labels"),
      ),
    ).toHaveLength(1);
    expect(
      sql.queries.filter((query) => query.includes("pg_advisory_xact_lock")),
    ).toHaveLength(1);
  });

  it("rejects labels bound to an account outside the business", async () => {
    const sql = createSqlMock((query) =>
      query.includes("FROM businesses business")
        ? [
            {
              business_ref_id: "biz_1",
              provider_account_ref_id: "account_ref_assigned",
              provider_account_id: "act_assigned",
            },
          ]
        : [],
    );
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      writeMetaCampaignLabels({
        businessId: "biz_1",
        labeledBy: "user_1",
        labels: [
          {
            campaignId: "cmp_1",
            kind: "main",
            providerAccountId: "act_other",
          },
        ],
      }),
    ).rejects.toThrow("providerAccountId is not assigned to this business");
    expect(
      sql.queries.some((query) =>
        query.includes("INSERT INTO meta_campaign_labels"),
      ),
    ).toBe(false);
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
