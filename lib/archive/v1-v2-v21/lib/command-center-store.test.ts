import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn().mockResolvedValue(undefined),
  getDbSchemaReadiness: vi.fn().mockResolvedValue({
    ready: true,
    missingTables: [],
    checkedAt: "2026-04-17T00:00:00.000Z",
  }),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `business-ref-${businessId}`] as const),
    );
  }),
}));

const {
  createCommandCenterSavedView,
  writeCommandCenterMutationReceipt,
} = await import("@/lib/command-center-store");

describe("command center store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sql.mockResolvedValue([
      {
        id: "view-1",
        business_id: "biz-1",
        view_key: "view_1",
        name: "My View",
        definition_json: {},
        created_at: "2026-04-17T00:00:00.000Z",
        updated_at: "2026-04-17T00:00:00.000Z",
      },
    ]);
  });

  it("writes canonical business refs for mutation receipts", async () => {
    sql.mockResolvedValueOnce([]);
    await writeCommandCenterMutationReceipt({
      businessId: "biz-1",
      clientMutationId: "mutation-1",
      mutationScope: "feedback",
      payload: { ok: true },
    });

    expect(String(sql.mock.calls[0]?.[0]?.join(" ") ?? "")).toContain("business_ref_id");
  });

  it("writes canonical business refs for saved views", async () => {
    await createCommandCenterSavedView({
      businessId: "biz-1",
      name: "My View",
      definition: {
        filters: [],
        sort: [],
      } as never,
    });

    expect(String(sql.mock.calls[0]?.[0]?.join(" ") ?? "")).toContain("business_ref_id");
  });
});
